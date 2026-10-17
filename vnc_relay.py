#!/usr/bin/env python3
"""One persistent graphical connection per Lume process; human clients see a relay.

The Apple private VNC implementation must never see browser/human reconnects or
arbitrary encoding lists. A failed upstream is quarantined until the VM process
changes. This is a trusted-development console, not a hostile-user boundary.
Configuration and credentials live outside Git and no passwords are logged.
"""
import fcntl
import hmac
from contextlib import contextmanager
import io
import json
import os
import queue
import re
import stat
import secrets
import signal
import socket
import socketserver
import struct
import subprocess
import threading
import time
import zlib
from PIL import Image, ImageChops
from pathlib import Path
from urllib.request import urlopen

# vncdotool 1.4.2 still refers to the old import location. Keep current
# cryptography and use its explicitly deprecated legacy cipher implementation.
from cryptography.hazmat.primitives.ciphers import algorithms, Cipher, modes
from cryptography.hazmat.decrepit.ciphers.algorithms import TripleDES
if not hasattr(algorithms, 'TripleDES'):
    algorithms.TripleDES = TripleDES
from vncdotool import api
from vncdotool.client import VNCDoToolClient, VNCDoToolFactory
from twisted.internet import reactor


class StableDesktopClient(VNCDoToolClient):
    def updateDesktopSize(self, width, height):
        # The stock client grows its Pillow canvas but leaves the RFB request
        # dimensions at the EFI/boot size, yielding black strips after resize.
        self.width, self.height = width, height
        super().updateDesktopSize(width, height)

    def updateRectangle(self, x, y, width, height, data):
        if data and width and height:
            self.has_pixels = True
        super().updateRectangle(x, y, width, height, data)

    def commitUpdate(self, rectangles=None):
        if not rectangles and getattr(self, 'has_pixels', False) and self.deferred:
            # An empty update is a valid no-change response, not a disconnect.
            d, self.deferred = self.deferred, None
            d.callback(self)
            return
        super().commitUpdate(rectangles)


class StableDesktopFactory(VNCDoToolFactory):
    protocol = StableDesktopClient

os.umask(0o077)
ROOT = Path(os.environ.get('SANDBOX_STATE_ROOT', Path.home() / '.local/state/mac-sandboxes')).expanduser().resolve()
CONTROL = Path(os.environ.get('SANDBOX_STATE_DIR', ROOT / 'control')).expanduser().resolve()
STORE = Path(os.environ.get('SANDBOX_VM_STORAGE', Path.home() / '.lume')).expanduser().resolve()
API = os.environ.get('SANDBOX_API', 'http://127.0.0.1:8787').rstrip('/')
LEDGER = ROOT / 'vnc-relay-ledger.json'
HEALTH = ROOT / 'vnc-relay-health.json'
POLICY = ROOT / 'vnc-relay-policy.json'
LOCK = threading.RLock()
STOP = threading.Event()
SESSIONS = {}
FAILURES = []


@contextmanager
def process_owner(root):
    """Hold one OS-level owner lock for the entire coordinator lifetime.

    Never unlink the lock: another process must lock the same inode, including
    after an owner exits. Unsupported locking/filesystems fail closed.
    """
    file = root / 'vnc-relay-owner.lock'
    fd = os.open(file, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or st.st_nlink != 1:
            raise ValueError('Unsafe relay owner lock')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        os.fchmod(fd, 0o600)
        current = file.lstat()
        if (current.st_dev, current.st_ino) != (st.st_dev, st.st_ino):
            raise ValueError('Relay owner lock changed')
        yield
    finally:
        os.close(fd)


def atomic_json(file, value):
    tmp = file.with_name(file.name + '.tmp')
    with open(tmp, 'w', encoding='utf8') as stream:
        json.dump(value, stream, separators=(',', ':'))
    os.chmod(tmp, 0o600)
    os.replace(tmp, file)


def read_json(file, fallback=None):
    try:
        with open(file, encoding='utf8') as stream:
            return json.load(stream)
    except FileNotFoundError:
        return fallback


def log(event, name, **fields):
    print(json.dumps({'at': time.time(), 'event': event, 'sandbox': name, **fields}), flush=True)


def inspect_process(pid):
    """running/gone/unknown; uncertainty must NEVER drop a live anchor."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return 'gone'
    except OSError:
        return 'unknown'
    try:
        result = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'stat=', '-o', 'comm='], capture_output=True, text=True, timeout=3)
        fields = result.stdout.strip().split(None, 1)
        if result.returncode == 1 and not result.stdout.strip() and not result.stderr.strip():
            return 'gone'
        if result.returncode or len(fields) != 2:
            return 'unknown'
        if fields[0].startswith('Z') or Path(fields[1]).name != 'lume':
            return 'gone'  # zombie or unrelated reused PID, not this live owner
        return 'running'
    except (OSError, ValueError, subprocess.SubprocessError):
        return 'unknown'


def inspect_identity(name):
    try:
        file = STORE / name / '.native-display-owner.json'
        owner_stat = file.lstat()
        if not stat.S_ISREG(owner_stat.st_mode) or owner_stat.st_uid != os.getuid():
            return 'unknown', None
        data = read_json(file, {})
        pid = data.get('processIdentifier')
        if type(pid) is not int or pid <= 1:
            return 'unknown', None
        state = inspect_process(pid)
        return state, '%s:%s' % (pid, owner_stat.st_mtime_ns) if state == 'running' else None
    except (OSError, ValueError, AttributeError):
        return 'unknown', None


def identity(name):
    return inspect_identity(name)[1]


def planned_shutdown(name):
    try:
        with urlopen(API + '/api/state', timeout=3) as response:
            data = json.load(response)
        return any(j.get('name') == name and j.get('status') == 'running' and j.get('action') in ('stop', 'kill', 'delete') for j in data.get('jobs', []))
    except Exception:
        return False


def auth_reply(password, challenge):
    raw = password.encode('latin1')[:8].ljust(8, b'\0')
    key = bytes(int(format(byte, '08b')[::-1], 2) for byte in raw)
    encryptor = Cipher(TripleDES(key * 3), modes.ECB()).encryptor()
    return encryptor.update(challenge) + encryptor.finalize()


def exact(sock, length):
    result = bytearray()
    while len(result) < length:
        part = sock.recv(length - len(result))
        if not part:
            raise EOFError()
        result.extend(part)
    return bytes(result)


def desktop_interval():
    """Fail closed on malformed configuration, never run an unbounded poll loop."""
    fps = int(os.environ.get('SANDBOX_DESKTOP_FPS', '15'))
    if not 1 <= fps <= 30:
        raise ValueError('SANDBOX_DESKTOP_FPS must be an integer from 1 to 30')
    return 1.0 / fps


class Session:
    def __init__(self, name, generation, port, password, upstream_password):
        self.name, self.generation, self.port = name, generation, port
        self.password, self.upstream_password = password, upstream_password
        self.upstream_port = port + 10000
        self.thread = None
        self.halt = threading.Event()
        self.ready = False
        self.error = None
        self.frame = None
        self.frame_count = 0
        self.last_frame = 0
        self.commands = queue.Queue(maxsize=1024)
        self.condition = threading.Condition()
        self.clients = set()
        self.server = None
        self.connected_at = None
        self.viewer_connections = 0
        self.input_events = 0
        self.disconnected = threading.Event()
        self.refresh_pending = False
        self.refresh_interval = desktop_interval()
        self.closed = False

    def start(self):
        # One admitted connection per runtime generation, persisted BEFORE connect.
        with LOCK:
            ledger = read_json(LEDGER, {})
            entry = ledger.get(self.name)
            if entry and entry.get('generation') == self.generation:
                self.error = 'Upstream session was previously attempted; controlled VM restart required.'
                self.closed = True
                log('quarantined', self.name)
                return
            ledger[self.name] = {'generation': self.generation, 'attemptedAt': time.time()}
            atomic_json(LEDGER, ledger)
        self.thread = threading.Thread(target=self.run, name='vnc-owner-' + self.name, daemon=True)
        self.thread.start()

    def run(self):
        client = None
        try:
            client = api.connect('127.0.0.1::%d' % self.upstream_port, password=self.upstream_password, factory_class=StableDesktopFactory, timeout=30)
            self.connected_at = time.time()
            client.factory._disconnect_callbacks.append(lambda _reason: self.disconnected.set())
            # First real framebuffer is required: a TCP/auth-only anchor is insufficient.
            client.refreshScreen(incremental=False)
            # api.connect is lazy: protocol exists only after the first sync call.
            reactor.callFromThread(client.protocol.transport.setTcpNoDelay, True)
            self.accept_frame(client)
            self.server = ConsoleServer(('0.0.0.0', self.port), ConsoleHandler)
            self.server.session = self
            threading.Thread(target=self.server.serve_forever, daemon=True).start()
            self.ready = True
            log('ready', self.name, port=self.port, generation=self.generation)
            reactor.callFromThread(self.request_refresh, client)
            while not self.halt.is_set() and not STOP.is_set():
                if self.disconnected.is_set():
                    raise ConnectionError('Upstream connection was lost')
                try:
                    item = self.commands.get(timeout=0.1)
                    kind, values = item
                    self.send_input(client, kind, values)
                    self.input_events += 1
                except queue.Empty:
                    pass
        except Exception as error:
            self.ready = False
            self.error = type(error).__name__
            # Never reconnect to the same running VZ process: that is the crash trigger.
            if identity(self.name) == self.generation and not self.halt.is_set() and not STOP.is_set() and not planned_shutdown(self.name):
                with LOCK:
                    FAILURES.append({'sandbox': self.name, 'at': time.time(), 'kind': type(error).__name__})
                log('upstream_failed_no_reconnect', self.name, kind=type(error).__name__)
        finally:
            self.ready = False
            self.close_viewers()
            if self.server:
                self.server.shutdown()
                self.server.server_close()
            if client:
                try:
                    client.disconnect()
                except Exception:
                    pass
            with self.condition:
                self.condition.notify_all()
            self.closed = True
            log('closed', self.name, frames=self.frame_count, viewers=self.viewer_connections)

    def request_refresh(self, client):
        # Keep ONE outstanding asynchronous framebuffer request. A static display
        # need not produce pixels within an arbitrary 12-second deadline, and
        # viewer/input handling must remain independent while it is unchanged.
        if self.refresh_pending or self.halt.is_set() or STOP.is_set() or not self.ready:
            return
        protocol = client.protocol
        if protocol is None or not protocol.transport.connected:
            self.disconnected.set()
            return
        self.refresh_pending = True
        requested_at = time.monotonic()
        def received(value):
            self.refresh_pending = False
            try:
                self.accept_frame(client)
            except Exception:
                self.disconnected.set()
                return value
            if not self.halt.is_set() and not STOP.is_set() and self.ready:
                # Cap request starts, not time spent waiting on a static desktop.
                delay = max(0, self.refresh_interval - (time.monotonic() - requested_at))
                reactor.callLater(delay, self.request_refresh, client)
            return value
        def failed(_reason):
            self.refresh_pending = False
            self.disconnected.set()
            return None
        try:
            protocol.refreshScreen(incremental=True).addCallbacks(received, failed)
        except Exception:
            self.refresh_pending = False
            self.disconnected.set()

    def send_input(self, client, kind, values):
        # Low-level RFB methods return None, unlike VNCDoTool's fluent helpers.
        # Call them on the reactor without replacing the factory's protocol
        # Deferred result (which would break the next screenshot request).
        completed = threading.Event()
        errors = []
        def deliver():
            try:
                protocol = client.protocol
                if protocol is None or not protocol.transport.connected:
                    raise ConnectionError('Upstream disconnected')
                if kind == 'pointer':
                    protocol.pointerEvent(*values)
                elif kind == 'key':
                    protocol.keyEvent(*values)
                elif kind == 'clipboard':
                    protocol.clientCutText(values[0])
            except Exception as error:
                errors.append(type(error).__name__)
            finally:
                completed.set()
        reactor.callFromThread(deliver)
        if not completed.wait(3) or errors:
            raise ConnectionError('Upstream input unavailable')

    def accept_frame(self, client):
        frame = client.screen
        if frame is None or not 0 < frame.width <= 4096 or not 0 < frame.height <= 4096:
            raise ValueError('Unexpected framebuffer size')
        # Published images are immutable. Compare outside the condition so input
        # and viewers never wait behind full-screen Pillow work. Only the single
        # upstream callback publishes; empty/identical updates are not new frames.
        frame = frame.convert('RGB')
        previous = self.frame
        if previous is not None and previous.size == frame.size and ImageChops.difference(previous, frame).getbbox() is None:
            return
        with self.condition:
            self.frame = frame
            self.frame_count += 1
            self.last_frame = time.time()
            self.condition.notify_all()

    def close_viewers(self):
        for sock in list(self.clients):
            try:
                sock.shutdown(socket.SHUT_RDWR)
                sock.close()
            except OSError:
                pass

    def stop_after_process_exit(self):
        self.ready = False
        self.halt.set()
        self.close_viewers()
        if self.server:
            self.server.shutdown()
            self.server.server_close()
        with self.condition:
            self.condition.notify_all()

    def info(self):
        verified = identity(self.name) == self.generation
        return {'generation': self.generation, 'ready': self.ready and verified, 'connected': self.ready and verified and not self.disconnected.is_set(),
                'frames': self.frame_count, 'lastFrameAt': self.last_frame,
                'viewerConnections': self.viewer_connections, 'inputEvents': self.input_events,
                'port': self.port, 'error': self.error}


class ConsoleServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class ViewerFramebuffer:
    """One viewer's reconstructed RGB pixels and coverage, never a global cursor.

    A partial request changes only its delivered rectangle in the baseline. The
    coverage mask distinguishes real black pixels from pixels never sent. RGB
    difference/getbbox deliberately avoids RGBA's all-zero-alpha getbbox trap.
    """
    def __init__(self):
        self.baseline = None
        self.pixel = None
        self.coverage = None
        self.complete_frame = None
        self.compared_frame = self.dirty_box = None
        # RFB encoding 6 is ONE continuous stream for this connection, even
        # across raw rectangles, resize, or a SetPixelFormat message.
        self.compressor = zlib.compressobj(level=1)

    def reset(self):
        self.baseline = self.coverage = self.complete_frame = None
        self.compared_frame = self.dirty_box = None

    def update(self, frame, request, pixel, encodings):
        incremental, box, _deadline = request
        if self.pixel != pixel or self.baseline is None or self.baseline.size != frame.size:
            self.reset()
            self.pixel = pixel
            self.baseline = Image.new('RGB', frame.size)
            self.coverage = Image.new('L', frame.size)
        x, y, right, bottom = box
        x, y = min(x, frame.width), min(y, frame.height)
        right, bottom = min(right, frame.width), min(bottom, frame.height)
        if x >= right or y >= bottom:
            return b'\0\0\0\0'
        all_current = False
        if incremental:
            if self.complete_frame is frame:
                return None
            if self.compared_frame is not frame:
                dirty = ImageChops.difference(self.baseline, frame).getbbox()
                missing = ImageChops.invert(self.coverage).getbbox()
                boxes = [b for b in (dirty, missing) if b is not None]
                self.dirty_box = ((min(b[0] for b in boxes), min(b[1] for b in boxes),
                                   max(b[2] for b in boxes), max(b[3] for b in boxes)) if boxes else None)
                self.compared_frame = frame
            dirty = self.dirty_box
            if dirty is None:
                self.complete_frame = frame
                return None
            all_current = x <= dirty[0] and y <= dirty[1] and right >= dirty[2] and bottom >= dirty[3]
            x, y = max(x, dirty[0]), max(y, dirty[1])
            right, bottom = min(right, dirty[2]), min(bottom, dirty[3])
            if x >= right or y >= bottom:
                return None
        box = (x, y, right, bottom)
        region = frame.crop(box)
        _, big, _, _, _, rs, gs, bs = pixel
        slots = [shift // 8 if not big else 3 - shift // 8 for shift in (rs, gs, bs)]
        order = ''.join('RGB'[slots.index(i)] if i in slots else 'X' for i in range(4))
        if order in ('RGBX', 'BGRX', 'XRGB', 'XBGR'):
            pixels = region.tobytes('raw', order)
        else:
            # Pillow's raw packers don't implement every legal shift ordering.
            # Merge byte lanes in C instead of per-pixel Python packing.
            bands = dict(zip('RGB', region.split()))
            bands['X'] = Image.new('L', region.size)
            pixels = Image.merge('RGBA', tuple(bands[channel] for channel in order)).tobytes()
        encoding = 6 if 6 in encodings else 0
        if encoding == 6:
            compressed = self.compressor.compress(pixels) + self.compressor.flush(zlib.Z_SYNC_FLUSH)
            pixels = struct.pack('>I', len(compressed)) + compressed
        self.baseline.paste(region, (x, y))
        self.coverage.paste(255, box)
        self.compared_frame = self.complete_frame = None  # Baseline changed.
        if all_current or box == (0, 0, frame.width, frame.height):
            self.complete_frame = frame
        return (struct.pack('>BBHHHHHi', 0, 0, 1, x, y, right - x, bottom - y, encoding)
                + pixels)


class ConsoleHandler(socketserver.BaseRequestHandler):
    # Coalesce floods into a single pending bounding rectangle, not an unbounded
    # queue of pixel payloads. One additional response may be in flight.
    idle_update_timeout = 1.0

    def queue_update(self, incremental, x, y, width, height):
        with self.server.session.condition:
            box = (x, y, x + width, y + height)
            deadline = time.monotonic() + self.idle_update_timeout
            if self.pending is not None:
                old_incremental, old, deadline = self.pending
                incremental = incremental and old_incremental
                box = (min(x, old[0]), min(y, old[1]),
                       max(box[2], old[2]), max(box[3], old[3]))
            self.pending = (incremental, box, deadline)
            self.request_serial += 1
            self.server.session.condition.notify_all()

    def write_updates(self):
        s = self.server.session
        framebuffer = ViewerFramebuffer()
        try:
            while True:
                with s.condition:
                    s.condition.wait_for(lambda: self.viewer_closed or not s.ready or s.halt.is_set()
                                         or STOP.is_set() or self.pending is not None)
                    if self.viewer_closed or not s.ready or s.halt.is_set() or STOP.is_set():
                        return
                    request = self.pending
                    serial, config = self.request_serial, self.config_serial
                    frame, count = s.frame, s.frame_count
                    pixel, encodings = self.pixel, self.encodings
                if frame.size != self.viewer_size:
                    if -223 not in encodings:
                        return  # Close this viewer only, never the upstream anchor.
                    reply = struct.pack('>BBHHHHHi', 0, 0, 1, 0, 0, frame.width, frame.height, -223)
                    self.viewer_size = frame.size
                    framebuffer.reset()
                else:
                    reply = framebuffer.update(frame, request, pixel, encodings)
                if reply is None:
                    remaining = request[2] - time.monotonic()
                    if remaining > 0:
                        with s.condition:
                            changed = s.condition.wait_for(lambda: self.viewer_closed or not s.ready or s.halt.is_set()
                                                           or STOP.is_set() or count != s.frame_count
                                                           or serial != self.request_serial or config != self.config_serial,
                                                           timeout=remaining)
                        if changed:
                            continue
                    reply = b'\0\0\0\0'  # No fake full/fresh frame on an idle timeout.
                self.request.sendall(reply)  # Only this thread writes after ServerInit.
                with s.condition:
                    if serial == self.request_serial:
                        self.pending = None
        except (OSError, ValueError):
            pass
        finally:
            with s.condition:
                self.viewer_closed = True
                s.condition.notify_all()
            try:
                self.request.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def handle(self):
        s = self.server.session
        conn = self.request
        conn.settimeout(20)
        conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        writer = None
        s.clients.add(conn)
        try:
            if not s.ready or s.frame is None:
                return
            conn.sendall(b'RFB 003.008\n')
            version = exact(conn, 12)
            if version not in (b'RFB 003.008\n', b'RFB 003.007\n', b'RFB 003.003\n'):
                return
            old = version == b'RFB 003.003\n'
            if old:
                conn.sendall(struct.pack('>I', 2))
            else:
                conn.sendall(b'\x01\x02')
                if exact(conn, 1) != b'\x02':
                    return
            challenge = secrets.token_bytes(16)
            conn.sendall(challenge)
            if not hmac.compare_digest(exact(conn, 16), auth_reply(s.password, challenge)):
                reason = b'Incorrect desktop password'
                conn.sendall(struct.pack('>I', 1) + (struct.pack('>I', len(reason)) + reason if version == b'RFB 003.008\n' else b''))
                return
            conn.sendall(struct.pack('>I', 0))
            exact(conn, 1)  # All viewers share the console; no destructive exclusive mode.
            with s.condition:
                width, height = s.frame.size
            # 32-bpp little-endian RGB, red at16 green8 blue0 (BGRA byte order).
            pixel = struct.pack('>BBBBHHHBBBxxx', 32, 24, 0, 1, 255, 255, 255, 16, 8, 0)
            label = s.name.encode('utf8')
            conn.sendall(struct.pack('>HH', width, height) + pixel + struct.pack('>I', len(label)) + label)
            s.viewer_connections += 1
            self.viewer_size = (width, height)
            self.encodings = set()
            self.pixel = (32, 0, 255, 255, 255, 16, 8, 0)
            self.pending = None
            self.request_serial = self.config_serial = 0
            self.viewer_closed = False
            conn.settimeout(180)
            # Authentication and ServerInit are fully written before ownership of
            # all subsequent socket writes moves to this one writer thread.
            writer = threading.Thread(target=self.write_updates, name='vnc-viewer-writer', daemon=True)
            writer.start()
            while s.ready and not s.halt.is_set() and not STOP.is_set() and not self.viewer_closed:
                kind = exact(conn, 1)[0]
                if kind == 0:  # SetPixelFormat
                    data = exact(conn, 19)[3:]
                    bpp, depth, big, true, rmax, gmax, bmax, rshift, gshift, bshift = struct.unpack('>BBBBHHHBBBxxx', data)
                    if not true or bpp != 32 or (rmax, gmax, bmax) != (255, 255, 255) or sorted((rshift, gshift, bshift)) != [0, 8, 16]:
                        return  # unsupported viewer format closes ONLY this client, never the VM
                    with s.condition:
                        self.pixel = (bpp, big, rmax, gmax, bmax, rshift, gshift, bshift)
                        self.config_serial += 1
                        s.condition.notify_all()
                elif kind == 2:  # SetEncodings: never forwarded to Apple VNC
                    header = exact(conn, 3)
                    count = struct.unpack('>H', header[1:])[0]
                    if count > 1024:
                        return
                    encodings = set(struct.unpack('>%di' % count, exact(conn, count * 4)))
                    with s.condition:
                        self.encodings = encodings
                        self.config_serial += 1
                        s.condition.notify_all()
                elif kind == 3:  # FramebufferUpdateRequest
                    data = exact(conn, 9)
                    incremental, x, y, rw, rh = struct.unpack('>BHHHH', data)
                    self.queue_update(bool(incremental), x, y, rw, rh)
                elif kind == 4:  # KeyEvent
                    data = exact(conn, 7)
                    s.commands.put_nowait(('key', (struct.unpack('>I', data[3:])[0], bool(data[0]))))
                elif kind == 5:  # PointerEvent
                    mask, x, y = struct.unpack('>BHH', exact(conn, 5))
                    with s.condition:
                        current_width, current_height = s.frame.size
                    s.commands.put_nowait(('pointer', (min(x, current_width - 1), min(y, current_height - 1), mask & 127)))
                elif kind == 6:  # ClientCutText
                    data = exact(conn, 7)
                    length = struct.unpack('>I', data[3:])[0]
                    if length > 16384:
                        return
                    text = exact(conn, length).decode('utf8', errors='replace')
                    s.commands.put_nowait(('clipboard', (text,)))
                else:
                    return
        except (OSError, EOFError, ValueError, queue.Full):
            pass
        finally:
            if writer is not None:
                with s.condition:
                    self.viewer_closed = True
                    s.condition.notify_all()
                try:
                    conn.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                writer.join(timeout=2)
            s.clients.discard(conn)


def admit_generation(name, generation):
    """Retire an old anchor only with exit proof, or after it already closed itself."""
    old = SESSIONS.get(name)
    if not generation or old and old.generation == generation:
        return False
    if old:
        if not old.closed and inspect_process(int(old.generation.split(':')[0])) != 'gone':
            return False
        old.stop_after_process_exit()
        del SESSIONS[name]
    return True


def reap_exited_sessions():
    for name, session in list(SESSIONS.items()):
        # Metadata disappearance, ps timeout and EPERM are NOT process-exit proof.
        if inspect_process(int(session.generation.split(':')[0])) == 'gone':
            session.stop_after_process_exit()
            if not session.thread or not session.thread.is_alive():
                del SESSIONS[name]


def main():
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    with process_owner(ROOT):
        run_coordinator()


def run_coordinator():
    # A corrupt ledger must fail closed rather than reconnect to old VZ processes.
    ledger = read_json(LEDGER, {})
    if not isinstance(ledger, dict):
        raise ValueError('Invalid relay ledger')
    while not STOP.is_set():
        try:
            policy = read_json(POLICY, {'prefix': 'space-'})
            with urlopen(API + '/api/state', timeout=5) as response:
                data = json.load(response)
            inventory_ok = not data.get('inventory', {}).get('error')
            if inventory_ok:
                ports = read_json(CONTROL / 'desktop-ports.json', {})
                for item in data.get('sandboxes', []):
                    name = item.get('name', '')
                    if not re.fullmatch(r'space-[a-z0-9][a-z0-9-]{0,30}', name) or not name.startswith(policy.get('prefix', 'space-')):
                        continue
                    generation = identity(name)
                    if item.get('status') != 'running' or not item.get('securityReady') or not admit_generation(name, generation):
                        continue
                    port = ports.get(name)
                    if not isinstance(port, int) or not 5901 <= port <= 5949:
                        continue
                    desktop_pw = (ROOT / 'credentials' / (name + '.vnc')).read_text().strip()
                    upstream_pw = (ROOT / 'credentials' / (name + '.vnc-upstream')).read_text().strip()
                    if not re.fullmatch(r'[A-Za-z0-9]{8}', desktop_pw) or not re.fullmatch(r'[A-Za-z0-9]{8}', upstream_pw) or desktop_pw == upstream_pw:
                        raise ValueError('Invalid separate desktop credentials')
                    session = Session(name, generation, port, desktop_pw, upstream_pw)
                    SESSIONS[name] = session
                    session.start()
            reap_exited_sessions()
            with LOCK:
                atomic_json(HEALTH, {'at': time.time(), 'inventoryVerified': inventory_ok,
                                    'sessions': {name: s.info() for name, s in SESSIONS.items()},
                                    'failures': FAILURES[-100:]})
        except Exception as error:
            log('coordinator_error', 'relay', kind=type(error).__name__)
        STOP.wait(1)
    for s in SESSIONS.values():
        s.stop_after_process_exit()
    api.shutdown()


if __name__ == '__main__':
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: STOP.set())
    main()
