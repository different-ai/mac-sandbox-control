import io
import socket
import struct
import threading
import time
import unittest
import zlib
from unittest.mock import Mock, patch
from PIL import Image, ImageChops
import vnc_relay as relay
from vncdotool import api


class RelayProtocolTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        api.shutdown()

    def setUp(self):
        self.session = relay.Session('space-fixture', 'fixture:1', 0, 'Test1234', 'Private8')
        self.session.frame = Image.new('RGB', (96, 64), (13, 90, 170))
        self.session.frame_count = 1
        self.session.last_frame = time.time()
        self.session.ready = True
        self.server = relay.ConsoleServer(('127.0.0.1', 0), relay.ConsoleHandler)
        self.server.session = self.session
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.session.ready = False
        self.session.close_viewers()
        self.server.shutdown()
        self.server.server_close()

    def client(self, password='Test1234'):
        return api.connect('127.0.0.1::%d' % self.port, password=password, timeout=3)

    def authenticated_socket(self):
        s = socket.create_connection(('127.0.0.1', self.port), timeout=3)
        self.assertEqual(relay.exact(s, 12), b'RFB 003.008\n')
        s.sendall(b'RFB 003.008\n')
        self.assertEqual(relay.exact(s, 2), b'\x01\x02')
        s.sendall(b'\x02')
        challenge = relay.exact(s, 16)
        s.sendall(relay.auth_reply('Test1234', challenge))
        self.assertEqual(relay.exact(s, 4), b'\0\0\0\0')
        s.sendall(b'\x01')
        initial = relay.exact(s, 24)
        relay.exact(s, struct.unpack('>I', initial[20:24])[0])
        return s

    def test_full_capture_and_repeated_reconnect_preserve_pixels(self):
        for _ in range(6):
            client = self.client()
            try:
                image = io.BytesIO()
                client.captureScreen(image, format='PNG')
                screen = Image.open(io.BytesIO(image.getvalue()))
                self.assertEqual(screen.size, (96, 64))
                self.assertEqual(screen.convert('RGB').getpixel((0, 0)), (13, 90, 170))
            finally:
                client.disconnect()
        self.assertEqual(self.session.viewer_connections, 6)
        self.assertTrue(self.session.ready)

    def test_wrong_password_is_rejected_without_disabling_other_clients(self):
        bad = self.client('Wrong123')
        try:
            with self.assertRaises(Exception):
                bad.refreshScreen()
        finally:
            bad.disconnect()
        good = self.client()
        try:
            good.refreshScreen()
        finally:
            good.disconnect()
        self.assertTrue(self.session.ready)

    def test_raw_encoding_list_is_consumed_not_forwarded(self):
        s = self.authenticated_socket()
        try:
            s.sendall(b'\x02\x00\x00\x01' + struct.pack('>i', 0))
            s.sendall(b'\x03\x00' + struct.pack('>HHHH', 0, 0, 96, 64))
            header = relay.exact(s, 16)
            self.assertEqual(header[:4], b'\x00\x00\x00\x01')
            self.assertEqual(len(relay.exact(s, 96 * 64 * 4)), 96 * 64 * 4)
        finally:
            s.close()
        self.assertTrue(self.session.ready)
        self.assertTrue(self.session.commands.empty())

    def test_input_is_queued_and_bounded_to_frame(self):
        s = self.authenticated_socket()
        try:
            s.sendall(b'\x05' + struct.pack('>BHH', 1, 65000, 65000))
            kind, values = self.session.commands.get(timeout=3)
            self.assertEqual((kind, values), ('pointer', (95, 63, 1)))
            s.sendall(b'\x04\x01\0\0' + struct.pack('>I', 65))
            kind, values = self.session.commands.get(timeout=3)
            self.assertEqual((kind, values), ('key', (65, True)))
        finally:
            s.close()

    def test_capable_viewer_receives_resize_and_can_reach_expanded_frame(self):
        s = self.authenticated_socket()
        try:
            s.sendall(b'\x02\0' + struct.pack('>Hii', 2, 0, -223))
            self.request_update(s)
            self.read_update(s)
            with self.session.condition:
                self.session.frame = Image.new('RGB', (192, 128), (13, 90, 170))
                self.session.frame_count += 1
                self.session.condition.notify_all()
            s.sendall(b'\x03\x01' + struct.pack('>HHHH', 0, 0, 96, 64))
            self.assertEqual(relay.exact(s, 16), struct.pack('>BBHHHHHi', 0, 0, 1, 0, 0, 192, 128, -223))
            s.sendall(b'\x03\x01' + struct.pack('>HHHH', 0, 0, 192, 128))
            self.assertEqual(relay.exact(s, 16), struct.pack('>BBHHHHHi', 0, 0, 1, 0, 0, 192, 128, 0))
            pixels = relay.exact(s, 192 * 128 * 4)
            self.assertEqual(pixels[-4:], bytes((170, 90, 13, 0)))
            s.sendall(b'\x05' + struct.pack('>BHH', 1, 65000, 65000))
            self.assertEqual(self.session.commands.get(timeout=3), ('pointer', (191, 127, 1)))
        finally:
            s.close()
        self.assertTrue(self.session.ready)
        self.assertFalse(self.session.halt.is_set())

    def test_resize_closes_incapable_viewer_without_closing_anchor(self):
        s = self.authenticated_socket()
        try:
            s.sendall(b'\x02\0' + struct.pack('>Hi', 1, 0))
            with self.session.condition:
                self.session.frame = Image.new('RGB', (192, 128), (13, 90, 170))
                self.session.frame_count += 1
                self.session.condition.notify_all()
            s.sendall(b'\x03\0' + struct.pack('>HHHH', 0, 0, 96, 64))
            self.assertEqual(s.recv(1), b'')
        finally:
            s.close()
        self.assertTrue(self.session.ready)
        self.assertFalse(self.session.halt.is_set())
        self.assertFalse(self.session.disconnected.is_set())
        client = self.client()
        try:
            client.refreshScreen()
            self.assertEqual(client.screen.size, (192, 128))
        finally:
            client.disconnect()

    def test_static_screen_remains_available_after_long_idle(self):
        self.session.last_frame = time.time() - 300
        client = self.client()
        try:
            client.refreshScreen()
            self.assertEqual(client.screen.size, (96, 64))
        finally:
            client.disconnect()
        self.assertTrue(self.session.ready)

    def test_boot_resize_updates_request_dimensions(self):
        client = relay.StableDesktopClient()
        client.width, client.height = 1280, 800
        client.updateDesktopSize(1920, 1080)
        self.assertEqual((client.width, client.height), (1920, 1080))
        self.assertEqual(client.screen.size, (1920, 1080))

    def test_empty_update_completes_a_valid_no_change_refresh(self):
        from twisted.internet.defer import Deferred
        client = relay.StableDesktopClient()
        client.screen = Image.new('RGB', (96, 64))
        client.has_pixels = True
        result = []
        d = client.deferred = Deferred()
        d.addCallback(lambda value: result.append(value))
        client.commitUpdate([])
        self.assertEqual(result, [client])
        self.assertIsNone(client.deferred)

    def test_oversized_encoding_message_closes_viewer_only(self):
        s = self.authenticated_socket()
        try:
            s.sendall(b'\x02\0' + struct.pack('>H', 1025))
            self.assertEqual(s.recv(1), b'')
        finally:
            s.close()
        self.assertTrue(self.session.ready)


    def request_update(self, sock, incremental=True, box=(0, 0, 96, 64)):
        x, y, right, bottom = box
        sock.sendall(struct.pack('>BBHHHH', 3, incremental, x, y, right - x, bottom - y))

    def read_update(self, sock, decompressor=None):
        kind, padding, count = struct.unpack('>BBH', relay.exact(sock, 4))
        self.assertEqual((kind, padding), (0, 0))
        rectangles = []
        for _ in range(count):
            x, y, width, height, encoding = struct.unpack('>HHHHi', relay.exact(sock, 12))
            if encoding == 6:
                length = struct.unpack('>I', relay.exact(sock, 4))[0]
                pixels = decompressor.decompress(relay.exact(sock, length))
            else:
                self.assertEqual(encoding, 0)
                pixels = relay.exact(sock, width * height * 4)
            self.assertEqual(len(pixels), width * height * 4)
            rectangles.append(((x, y, x + width, y + height), pixels, encoding))
        return rectangles

    def publish(self, frame):
        self.session.accept_frame(Mock(screen=frame))

    def test_zlib_stream_across_updates_reconstructs_pixels(self):
        s = self.authenticated_socket()
        try:
            s.sendall(struct.pack('>BBHii', 2, 0, 2, 6, 0))
            decoder = zlib.decompressobj()
            self.request_update(s)
            first = self.read_update(s, decoder)
            self.assertEqual(first[0][2], 6)
            reconstructed = Image.new('RGB', (96, 64))
            for box, pixels, _ in first:
                reconstructed.paste(Image.frombytes('RGB', (box[2] - box[0], box[3] - box[1]), pixels, 'raw', 'BGRX'), box[:2])
            changed = self.session.frame.copy()
            changed.paste((255, 17, 10), (7, 11, 15, 18))
            self.publish(changed)
            self.request_update(s)
            second = self.read_update(s, decoder)
            self.assertEqual(second[0][0], (7, 11, 15, 18))
            self.assertEqual(second[0][2], 6)
            for box, pixels, _ in second:
                reconstructed.paste(Image.frombytes('RGB', (box[2] - box[0], box[3] - box[1]), pixels, 'raw', 'BGRX'), box[:2])
            self.assertIsNone(ImageChops.difference(reconstructed, changed).getbbox())
            self.assertFalse(decoder.eof)  # Z_SYNC_FLUSH, not independently reset streams.
        finally:
            s.close()

    def test_static_incremental_returns_zero_rectangles_not_full_frame(self):
        s = self.authenticated_socket()
        try:
            self.request_update(s)
            self.read_update(s)
            count, updated_at = self.session.frame_count, self.session.last_frame
            self.request_update(s)
            self.assertEqual(self.read_update(s), [])
            self.assertEqual((self.session.frame_count, self.session.last_frame), (count, updated_at))
        finally:
            s.close()

    def test_reader_accepts_input_while_incremental_request_waits(self):
        with patch.object(relay.ConsoleHandler, 'idle_update_timeout', 5.0):
            s = self.authenticated_socket()
            try:
                self.request_update(s)
                self.read_update(s)
                self.request_update(s)
                s.sendall(b'\x04\x01\0\0' + struct.pack('>I', 65)
                          + b'\x05' + struct.pack('>BHH', 1, 4, 8)
                          + b'\x06\0\0\0' + struct.pack('>I', 4) + b'test')
                self.assertEqual(self.session.commands.get(timeout=2), ('key', (65, True)))
                self.assertEqual(self.session.commands.get(timeout=2), ('pointer', (4, 8, 1)))
                self.assertEqual(self.session.commands.get(timeout=2), ('clipboard', ('test',)))
                changed = self.session.frame.copy()
                changed.putpixel((3, 5), (14, 90, 170))  # Red-only change, alpha must not hide it.
                self.publish(changed)
                self.assertEqual(self.read_update(s)[0][0], (3, 5, 4, 6))
            finally:
                s.close()

    def test_reader_remains_responsive_while_writer_is_backpressured(self):
        writing, release = threading.Event(), threading.Event()

        class BackpressuredSocket:
            def __init__(self, sock):
                self.sock = sock

            def __getattr__(self, name):
                return getattr(self.sock, name)

            def sendall(self, data):
                if threading.current_thread().name == 'vnc-viewer-writer':
                    writing.set()
                    if not release.wait(5):
                        raise TimeoutError('Synthetic viewer backpressure')
                self.sock.sendall(data)

        def wrap_socket(handler):
            handler.request = BackpressuredSocket(handler.request)

        with patch.object(relay.ConsoleHandler, 'setup', wrap_socket):
            s = self.authenticated_socket()
            try:
                self.request_update(s)
                self.assertTrue(writing.wait(2))
                s.sendall(b'\x04\x01\0\0' + struct.pack('>I', 65))
                self.assertEqual(self.session.commands.get(timeout=2), ('key', (65, True)))
                release.set()
                self.assertEqual(self.read_update(s)[0][0], (0, 0, 96, 64))
            finally:
                release.set()
                s.close()
        self.assertTrue(self.session.ready)
        self.assertFalse(self.session.disconnected.is_set())

    def test_viewer_disconnect_wakes_idle_writer_without_closing_upstream(self):
        writers = []
        original = relay.ConsoleHandler.write_updates

        def track_writer(handler):
            writers.append(threading.current_thread())
            original(handler)

        with patch.object(relay.ConsoleHandler, 'write_updates', track_writer), \
                patch.object(relay.ConsoleHandler, 'idle_update_timeout', 5.0):
            s = self.authenticated_socket()
            try:
                self.request_update(s)
                self.read_update(s)
                self.request_update(s)
            finally:
                s.close()
            self.assertEqual(len(writers), 1)
            writers[0].join(timeout=2)
            self.assertFalse(writers[0].is_alive())
        self.assertTrue(self.session.ready)
        self.assertFalse(self.session.halt.is_set())
        self.assertFalse(self.session.disconnected.is_set())

    def test_pixel_format_change_forces_full_incremental_refresh(self):
        s = self.authenticated_socket()
        try:
            self.request_update(s)
            self.read_update(s)
            pixel = struct.pack('>BBBBHHHBBBxxx', 32, 24, 1, 1, 255, 255, 255, 0, 8, 16)
            s.sendall(b'\0\0\0\0' + pixel)
            self.request_update(s)
            rectangle = self.read_update(s)[0]
            self.assertEqual(rectangle[0], (0, 0, 96, 64))
            self.assertEqual(rectangle[1][:4], bytes((0, 170, 90, 13)))
        finally:
            s.close()

    def test_coalesced_request_state_is_bounded_and_nonincremental_wins(self):
        handler = relay.ConsoleHandler.__new__(relay.ConsoleHandler)
        handler.server = self.server
        handler.pending = None
        handler.request_serial = 0
        for i in range(10000):
            handler.queue_update(i != 5000, i % 90, i % 60, 6, 4)
        incremental, box, deadline = handler.pending
        self.assertFalse(incremental)
        self.assertEqual(box, (0, 0, 95, 63))
        self.assertLessEqual(deadline, time.monotonic() + handler.idle_update_timeout)
        self.assertEqual(handler.request_serial, 10000)


class ViewerFramebufferTests(unittest.TestCase):
    pixel = (32, 0, 255, 255, 255, 16, 8, 0)

    def update(self, viewer, frame, box=None, incremental=True, pixel=None, encodings=()):
        box = box or (0, 0, frame.width, frame.height)
        return viewer.update(frame, (incremental, box, 0), pixel or self.pixel, encodings)

    def decode(self, packet, pixel=None, decoder=None):
        self.assertEqual(packet[:4], b'\0\0\0\x01')
        x, y, width, height, encoding = struct.unpack('>HHHHi', packet[4:16])
        data = packet[16:]
        if encoding == 6:
            length = struct.unpack('>I', data[:4])[0]
            self.assertEqual(length, len(data) - 4)
            data = decoder.decompress(data[4:])
        else:
            self.assertEqual(encoding, 0)
        pixel = pixel or self.pixel
        self.assertEqual(len(data), width * height * 4)
        order = 'big' if pixel[1] else 'little'
        rgb = bytes((int.from_bytes(data[i:i + 4], order) >> shift) & 255
                    for i in range(0, len(data), 4) for shift in pixel[-3:])
        return (x, y, x + width, y + height), Image.frombytes('RGB', (width, height), rgb)

    def test_raw_initial_incremental_includes_unknown_black_pixels(self):
        viewer = relay.ViewerFramebuffer()
        frame = Image.new('RGB', (12, 8))
        box, pixels = self.decode(self.update(viewer, frame))
        self.assertEqual(box, (0, 0, 12, 8))
        self.assertEqual(pixels.tobytes(), frame.tobytes())
        self.assertIsNone(self.update(viewer, frame))

    def test_raw_partial_delta_preserves_baseline_outside_request(self):
        viewer = relay.ViewerFramebuffer()
        frame = Image.new('RGB', (12, 8), (10, 20, 30))
        self.update(viewer, frame)
        changed = frame.copy()
        changed.putpixel((1, 2), (99, 20, 30))
        changed.putpixel((10, 5), (10, 88, 30))
        first, pixels = self.decode(self.update(viewer, changed, (0, 0, 6, 8)))
        self.assertEqual(first, (1, 2, 6, 6))  # Intersect the dirty bounding rectangle.
        self.assertEqual(viewer.baseline.getpixel((10, 5)), (10, 20, 30))
        second, pixels = self.decode(self.update(viewer, changed, (6, 0, 12, 8)))
        self.assertEqual(second, (10, 5, 11, 6))
        self.assertEqual(pixels.getpixel((0, 0)), (10, 88, 30))
        self.assertEqual(viewer.baseline.tobytes(), changed.tobytes())
        self.assertIsNone(self.update(viewer, changed))

    def test_partial_initial_coverage_and_nonincremental_always_full_requested(self):
        viewer = relay.ViewerFramebuffer()
        frame = Image.new('RGB', (12, 8))
        self.assertEqual(self.decode(self.update(viewer, frame, (0, 0, 6, 8)))[0], (0, 0, 6, 8))
        self.assertIsNone(self.update(viewer, frame, (0, 0, 6, 8)))
        self.assertEqual(self.decode(self.update(viewer, frame, (6, 0, 12, 8)))[0], (6, 0, 12, 8))
        self.assertIsNone(self.update(viewer, frame))
        self.assertEqual(self.decode(self.update(viewer, frame, (2, 1, 9, 5), False))[0], (2, 1, 9, 5))

    def test_pixel_endian_and_channel_shift_variants_round_trip(self):
        import itertools
        frame = Image.new('RGB', (3, 2), (13, 90, 170))
        for big in (0, 1):
            for shifts in itertools.permutations((0, 8, 16)):
                with self.subTest(big=big, shifts=shifts):
                    pixel = (32, big, 255, 255, 255) + shifts
                    packet = self.update(relay.ViewerFramebuffer(), frame, pixel=pixel)
                    self.assertEqual(self.decode(packet, pixel)[1].tobytes(), frame.tobytes())

    def test_resize_and_new_format_reset_coverage_but_not_zlib_stream(self):
        viewer, decoder = relay.ViewerFramebuffer(), zlib.decompressobj()
        frame = Image.new('RGB', (12, 8), (1, 2, 3))
        self.decode(self.update(viewer, frame, encodings=(6,)), decoder=decoder)
        viewer.reset()  # DesktopSize response resets coverage, not compression.
        resized = Image.new('RGB', (24, 16), (1, 2, 3))
        box, pixels = self.decode(self.update(viewer, resized, encodings=(6,)), decoder=decoder)
        self.assertEqual(box, (0, 0, 24, 16))
        new_pixel = (32, 1, 255, 255, 255, 0, 8, 16)
        box, pixels = self.decode(self.update(viewer, resized, pixel=new_pixel, encodings=(6,)), new_pixel, decoder)
        self.assertEqual(box, (0, 0, 24, 16))
        self.assertEqual(pixels.tobytes(), resized.tobytes())
        self.assertFalse(decoder.eof)

    def test_viewers_have_independent_baselines_and_coverage(self):
        first, second = relay.ViewerFramebuffer(), relay.ViewerFramebuffer()
        frame = Image.new('RGB', (12, 8), (1, 2, 3))
        self.update(first, frame)
        self.update(second, frame, (0, 0, 6, 8))
        changed = frame.copy()
        changed.putpixel((2, 3), (9, 2, 3))
        self.assertEqual(self.decode(self.update(first, changed))[0], (2, 3, 3, 4))
        # The second viewer still needs its changed pixel AND never-sent region.
        box, pixels = self.decode(self.update(second, changed))
        self.assertEqual(box, (2, 0, 12, 8))
        self.assertEqual(pixels.getpixel((0, 3)), (9, 2, 3))
        self.assertEqual(second.baseline.tobytes(), changed.tobytes())
        self.assertIsNone(self.update(first, changed))
        self.assertIsNone(self.update(second, changed))

    def test_encoding_six_only_when_advertised_and_stream_survives_raw(self):
        viewer, decoder = relay.ViewerFramebuffer(), zlib.decompressobj()
        frame = Image.new('RGB', (12, 8), (1, 2, 3))
        self.decode(self.update(viewer, frame, encodings=(6,)), decoder=decoder)
        frame.putpixel((2, 2), (33, 2, 3))
        raw = self.update(viewer, frame, incremental=False, encodings=(5, 16))
        self.assertEqual(struct.unpack('>i', raw[12:16])[0], 0)
        self.decode(raw)
        compressed = self.update(viewer, frame, incremental=False, encodings=(6,))
        self.assertEqual(self.decode(compressed, decoder=decoder)[1].tobytes(), frame.tobytes())

    def test_identical_upstream_updates_do_not_publish_or_advance_health(self):
        session = relay.Session('space-fixture', 'fixture:1', 0, 'Test1234', 'Private8')
        frame = Image.new('RGBA', (12, 8), (1, 2, 3, 0))
        client = Mock(screen=frame)
        session.accept_frame(client)
        first, count, stamp = session.frame, session.frame_count, session.last_frame
        session.accept_frame(client)
        self.assertIs(session.frame, first)
        self.assertEqual((session.frame_count, session.last_frame), (count, stamp))
        frame.putpixel((2, 3), (2, 2, 3, 0))  # Transparent source still has meaningful RGB.
        session.accept_frame(client)
        self.assertEqual(session.frame_count, count + 1)
        self.assertEqual(first.getpixel((2, 3)), (1, 2, 3))  # Published snapshots immutable.

    def test_static_complete_frame_avoids_idle_pillow_difference(self):
        viewer = relay.ViewerFramebuffer()
        frame = Image.new('RGB', (12, 8), (1, 2, 3))
        self.update(viewer, frame)
        with patch.object(relay.ImageChops, 'difference', side_effect=AssertionError('Idle scan')):
            for _ in range(20):
                self.assertIsNone(self.update(viewer, frame))

    def test_static_partial_region_caches_dirty_bounds_without_idle_image_work(self):
        viewer = relay.ViewerFramebuffer()
        frame = Image.new('RGB', (12, 8), (1, 2, 3))
        self.update(viewer, frame, (0, 0, 6, 8))
        self.assertIsNone(self.update(viewer, frame, (0, 0, 6, 8)))
        with patch.object(relay.ImageChops, 'difference', side_effect=AssertionError('Idle scan')):
            for _ in range(20):
                self.assertIsNone(self.update(viewer, frame, (0, 0, 6, 8)))
        self.assertEqual(self.decode(self.update(viewer, frame, (6, 0, 12, 8)))[0], (6, 0, 12, 8))

    def test_empty_or_out_of_bounds_requests_return_zero_rectangles(self):
        viewer = relay.ViewerFramebuffer()
        frame = Image.new('RGB', (12, 8))
        self.assertEqual(self.update(viewer, frame, (20, 20, 25, 25)), b'\0\0\0\0')
        self.assertEqual(self.update(viewer, frame, (2, 2, 2, 8)), b'\0\0\0\0')


class RelayOwnershipTests(unittest.TestCase):
    def test_process_owner_excludes_second_coordinator_before_ledger_or_upstream(self):
        import subprocess
        import sys
        import tempfile
        from pathlib import Path
        script = '''
import sys
from pathlib import Path
import vnc_relay as relay
relay.ROOT = Path(sys.argv[1])
def forbidden(*args, **kwargs):
    raise AssertionError('Coordinator reached ledger or upstream before ownership')
relay.read_json = relay.urlopen = relay.api.connect = forbidden
try:
    relay.main()
except BlockingIOError:
    print('blocked-before-coordinator', flush=True)
else:
    raise AssertionError('Second coordinator was admitted')
'''
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with relay.process_owner(root):
                result = subprocess.run([sys.executable, '-c', script, directory],
                                        cwd=Path(__file__).resolve().parent,
                                        capture_output=True, text=True, timeout=15)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), 'blocked-before-coordinator')
                self.assertEqual((root / 'vnc-relay-owner.lock').stat().st_mode & 0o777, 0o600)
            # The persistent inode remains, but ownership is released on exit.
            release_script = '''
import sys
from pathlib import Path
import vnc_relay as relay
with relay.process_owner(Path(sys.argv[1])):
    print('acquired', flush=True)
'''
            result = subprocess.run([sys.executable, '-c', release_script, directory],
                                    cwd=Path(__file__).resolve().parent,
                                    capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), 'acquired')

    def test_process_owner_rejects_symlink_without_touching_target(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'target'
            target.write_text('unchanged')
            target.chmod(0o644)
            (root / 'vnc-relay-owner.lock').symlink_to(target)
            with self.assertRaises(OSError):
                with relay.process_owner(root):
                    self.fail('Symlink lock was admitted')
            self.assertEqual(target.read_text(), 'unchanged')
            self.assertEqual(target.stat().st_mode & 0o777, 0o644)

    def test_process_owner_tightens_mode_and_releases_after_failure(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            lock = root / 'vnc-relay-owner.lock'
            lock.touch(mode=0o644)
            lock.chmod(0o644)
            inode = lock.stat().st_ino
            with self.assertRaisesRegex(RuntimeError, 'fixture'):
                with relay.process_owner(root):
                    self.assertEqual(lock.stat().st_mode & 0o777, 0o600)
                    raise RuntimeError('fixture')
            with relay.process_owner(root):
                self.assertEqual(lock.stat().st_ino, inode)

    def test_inspection_timeout_and_permission_failure_keep_live_anchor(self):
        from unittest.mock import Mock, patch
        import subprocess
        session = relay.Session('space-fixture', '123:456', 5901, 'Test1234', 'Private8')
        session.stop_after_process_exit = Mock()
        with patch.object(relay, 'SESSIONS', {'space-fixture': session}), \
                patch.object(relay.os, 'kill'), \
                patch.object(relay.subprocess, 'run', side_effect=subprocess.TimeoutExpired('ps', 3)):
            self.assertEqual(relay.inspect_process(123), 'unknown')
            relay.reap_exited_sessions()
            self.assertFalse(relay.admit_generation('space-fixture', None))
            self.assertFalse(relay.admit_generation('space-fixture', '123:789'))
            session.stop_after_process_exit.assert_not_called()
            session.ready = True
            with patch.object(relay, 'identity', return_value=None):
                self.assertFalse(session.info()['ready'])
                self.assertTrue(session.ready)  # health uncertainty never tears down anchor
        with patch.object(relay.os, 'kill', side_effect=PermissionError()):
            self.assertEqual(relay.inspect_process(123), 'unknown')

    def test_confirmed_exit_reaps_but_closed_old_session_allows_reused_pid(self):
        from unittest.mock import Mock, patch
        session = relay.Session('space-fixture', '123:456', 5901, 'Test1234', 'Private8')
        session.stop_after_process_exit = Mock()
        with patch.object(relay, 'SESSIONS', {'space-fixture': session}), \
                patch.object(relay.os, 'kill', side_effect=ProcessLookupError()):
            relay.reap_exited_sessions()
            session.stop_after_process_exit.assert_called_once()
            self.assertNotIn('space-fixture', relay.SESSIONS)
        session.closed = True
        session.stop_after_process_exit.reset_mock()
        with patch.object(relay, 'SESSIONS', {'space-fixture': session}), \
                patch.object(relay, 'inspect_process', return_value='running'):
            self.assertFalse(relay.admit_generation('space-fixture', '123:456'))
            self.assertTrue(relay.admit_generation('space-fixture', '123:789'))
            session.stop_after_process_exit.assert_called_once()

    def test_zombie_and_unrelated_pid_are_exit_proof_but_malformed_ps_is_unknown(self):
        from unittest.mock import Mock, patch
        for output, expected in [('Z /bin/lume', 'gone'), ('S /bin/other', 'gone'), ('garbled', 'unknown')]:
            with patch.object(relay.os, 'kill'), patch.object(relay.subprocess, 'run', return_value=Mock(returncode=0, stdout=output, stderr='')):
                self.assertEqual(relay.inspect_process(123), expected)

    def test_ledger_quarantines_same_generation_after_owner_restart(self):
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            ledger = Path(directory) / 'ledger.json'
            relay.atomic_json(ledger, {'space-fixture': {'generation': '123:456'}})
            with patch.object(relay, 'LEDGER', ledger), patch.object(relay.threading, 'Thread') as thread:
                session = relay.Session('space-fixture', '123:456', 5901, 'Test1234', 'Private8')
                session.start()
                thread.assert_not_called()
                self.assertFalse(session.ready)
                self.assertIsNotNone(session.error)

    def test_upstream_failure_never_reconnects_or_stops_compute(self):
        from unittest.mock import patch
        session = relay.Session('space-fixture', '123:456', 5901, 'Test1234', 'Private8')
        with patch.object(relay.api, 'connect', side_effect=ConnectionError('fixture')) as connect, \
                patch.object(relay, 'identity', return_value='123:456'), \
                patch.object(relay, 'planned_shutdown', return_value=False), \
                patch.object(relay, 'FAILURES', []):
            session.run()
            connect.assert_called_once()
            self.assertFalse(session.ready)
            self.assertEqual(session.error, 'ConnectionError')

    def test_fps_configuration_defaults_and_range_validation(self):
        with patch.dict(relay.os.environ, {}, clear=True):
            self.assertAlmostEqual(relay.desktop_interval(), 1 / 15)
        for fps in (1, 7, 15, 30):
            with self.subTest(fps=fps), patch.dict(relay.os.environ, {'SANDBOX_DESKTOP_FPS': str(fps)}):
                self.assertAlmostEqual(relay.desktop_interval(), 1 / fps)
        for value in ('0', '31', '-1', '15.5', 'nan', '', 'unbounded'):
            with self.subTest(value=value), patch.dict(relay.os.environ, {'SANDBOX_DESKTOP_FPS': value}):
                with self.assertRaises(ValueError):
                    relay.desktop_interval()

    def test_refresh_schedule_caps_request_start_rate_without_static_delay(self):
        from twisted.internet.defer import Deferred
        for elapsed in (0.01, 10.0):
            with self.subTest(elapsed=elapsed):
                session = relay.Session('space-fixture', '123:456', 5901, 'Test1234', 'Private8')
                session.ready = True
                session.refresh_interval = 1 / 15
                session.accept_frame = Mock()
                client = Mock()
                deferred = Deferred()
                client.protocol.refreshScreen.return_value = deferred
                with patch.object(relay.reactor, 'callLater') as later, \
                        patch.object(relay.time, 'monotonic', side_effect=[100, 100 + elapsed]):
                    session.request_refresh(client)
                    session.request_refresh(client)
                    client.protocol.refreshScreen.assert_called_once_with(incremental=True)
                    deferred.callback(client)
                    self.assertFalse(session.refresh_pending)
                    self.assertAlmostEqual(later.call_args.args[0], max(0, 1 / 15 - elapsed))
                    self.assertLessEqual(later.call_args.args[0], 1 / 15)

    def test_initial_upstream_refresh_is_full_and_connection_is_not_repeated(self):
        session = relay.Session('space-fixture', '123:456', 5901, 'Test1234', 'Private8')
        client = Mock()
        client.protocol = None  # api.connect returns before authentication finishes.
        def connected(*args, **kwargs):
            client.protocol = Mock()
        client.refreshScreen.side_effect = connected
        def accept(_client):
            session.halt.set()
        session.accept_frame = accept
        with patch.object(relay.api, 'connect', return_value=client) as connect, \
                patch.object(relay, 'ConsoleServer'), patch.object(relay.reactor, 'callFromThread'):
            session.run()
        connect.assert_called_once()
        client.refreshScreen.assert_called_once_with(incremental=False)
        client.disconnect.assert_called_once()
        self.assertIsNone(session.error)

    def test_only_one_outstanding_framebuffer_request(self):
        from unittest.mock import Mock
        session = relay.Session('space-fixture', '123:456', 5901, 'Test1234', 'Private8')
        session.ready = True
        client = Mock()
        client.protocol.transport.connected = True
        session.request_refresh(client)
        session.request_refresh(client)
        client.protocol.refreshScreen.assert_called_once_with(incremental=True)
        self.assertTrue(session.refresh_pending)


if __name__ == '__main__':
    unittest.main(verbosity=2)
