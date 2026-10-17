#!/usr/bin/env python3
"""Read-only viewer benchmark. Password arrives on stdin; never printed or saved.
Modes: live (--host plus stdin JSON), synthetic --source /path/vnc_relay.py.
Live credentials use {"port":5901,"password":"..."} on stdin; never use argv.
Synthetic screenshots are generated in memory and never resemble real work.
"""
import argparse
import importlib.util
import json
import socket
import struct
import sys
import threading
import time
import zlib
from pathlib import Path
from cryptography.hazmat.primitives.ciphers import Cipher, modes
from cryptography.hazmat.decrepit.ciphers.algorithms import TripleDES


def exact(sock, count):
    buf = bytearray()
    while len(buf) < count:
        part = sock.recv(count - len(buf))
        if not part:
            raise EOFError('Viewer connection closed')
        buf.extend(part)
    return bytes(buf)


def response(password, challenge):
    key = bytes(int(format(b, '08b')[::-1], 2) for b in password.encode('latin1')[:8].ljust(8, b'\0'))
    enc = Cipher(TripleDES(key * 3), modes.ECB()).encryptor()
    return enc.update(challenge) + enc.finalize()


class Viewer:
    def __init__(self, host, port, password):
        self.sock = socket.create_connection((host, port), timeout=20)
        self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.sock.settimeout(20)
        self.decoder = zlib.decompressobj()
        exact(self.sock, 12)
        self.sock.sendall(b'RFB 003.008\n')
        count = exact(self.sock, 1)[0]
        offered = exact(self.sock, count)
        if 2 not in offered:
            raise RuntimeError('VNC password authentication not offered')
        self.sock.sendall(b'\x02')
        self.sock.sendall(response(password, exact(self.sock, 16)))
        if struct.unpack('>I', exact(self.sock, 4))[0] != 0:
            raise RuntimeError('VNC authentication failed')
        self.sock.sendall(b'\x01')
        header = exact(self.sock, 24)
        self.width, self.height = struct.unpack('>HH', header[:4])
        exact(self.sock, struct.unpack('>I', header[20:24])[0])
        self.sock.sendall(struct.pack('>BBHiii', 2, 0, 3, 6, 0, -223))

    def update(self, incremental):
        start = time.monotonic()
        self.sock.sendall(struct.pack('>BBHHHH', 3, incremental, 0, 0, self.width, self.height))
        kind, _, count = struct.unpack('>BBH', exact(self.sock, 4))
        if kind != 0:
            raise RuntimeError('Unexpected server message')
        total, pixels, encodings = 4, 0, []
        for _ in range(count):
            x, y, w, h, enc = struct.unpack('>HHHHi', exact(self.sock, 12))
            total += 12
            encodings.append(enc)
            if enc == -223:
                self.width, self.height = w, h
                continue
            if enc == 0:
                data = exact(self.sock, w * h * 4)
                total += len(data)
            elif enc == 6:
                length = struct.unpack('>I', exact(self.sock, 4))[0]
                data = self.decoder.decompress(exact(self.sock, length))
                total += 4 + length
                if len(data) != w * h * 4:
                    raise RuntimeError('Invalid compressed pixel length')
            else:
                raise RuntimeError('Unexpected encoding ' + str(enc))
            pixels += w * h
        return {'seconds': time.monotonic() - start, 'bytes': total, 'pixels': pixels, 'encodings': encodings}

    def close(self):
        self.sock.close()


def measure(viewer, samples, pause=0):
    first = viewer.update(False)
    rows = []
    for _ in range(samples):
        if pause:
            time.sleep(pause)
        rows.append(viewer.update(True))
    times = sorted(row['seconds'] for row in rows)
    total = sum(row['bytes'] for row in rows)
    return {'size': [viewer.width, viewer.height], 'initialBytes': first['bytes'], 'samples': samples,
            'incrementalBytes': total, 'meanUpdateMs': round(sum(times)/len(times)*1000, 2),
            'p95UpdateMs': round(times[min(len(times)-1, int(len(times)*.95))]*1000, 2),
            'encodings': sorted(set(enc for row in rows for enc in row['encodings'])),
            'meanPixelsPerUpdate': round(sum(row['pixels'] for row in rows)/len(rows))}


def synthetic(source, samples):
    from PIL import Image, ImageDraw
    spec = importlib.util.spec_from_file_location('bench_relay', source)
    relay = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(relay)
    session = relay.Session('space-fixture', 'fixture:1', 0, 'Test1234', 'Private8')
    image = Image.new('RGB', (1920, 1080), '#fafafa')
    draw = ImageDraw.Draw(image)
    for y in range(80, 850, 80):
        draw.rectangle((100, y, 1700, y+60), fill='#e2e8f0')
    session.frame = image.copy()
    session.frame_count = 1
    session.last_frame = time.time()
    session.ready = True
    server = relay.ConsoleServer(('127.0.0.1', 0), relay.ConsoleHandler)
    server.session = session
    threading.Thread(target=server.serve_forever, daemon=True).start()
    halted = threading.Event()

    def animate():
        i = 0
        while not halted.wait(1 / 15):
            frame = image.copy()
            d = ImageDraw.Draw(frame)
            d.rectangle((200, 100, 599, 139), fill=(i % 256, 80, 170))
            with session.condition:
                session.frame = frame
                session.frame_count += 1
                session.last_frame = time.time()
                session.condition.notify_all()
            i += 1
    threading.Thread(target=animate, daemon=True).start()
    viewer = Viewer('127.0.0.1', server.server_address[1], 'Test1234')
    try:
        result = measure(viewer, samples)
        result['fixture'] = '1920x1080; 400x40 rectangle changes at 15 Hz; loopback stub; no VM'
        return result
    finally:
        viewer.close()
        halted.set()
        session.ready = False
        session.close_viewers()
        with session.condition:
            session.condition.notify_all()
        server.shutdown()
        server.server_close()


parser = argparse.ArgumentParser()
parser.add_argument('--source')
parser.add_argument('--samples', type=int, default=15)
parser.add_argument('--host', default='127.0.0.1')
args = parser.parse_args()
if not 1 <= args.samples <= 1000:
    parser.error('--samples must be between 1 and 1000')
if args.source:
    data = synthetic(args.source, args.samples)
else:
    creds = json.load(sys.stdin)
    if type(creds.get('port')) is not int or not 5901 <= creds['port'] <= 5949:
        parser.error('Live benchmarks require a human relay port in 5901–5949, never a native upstream port')
    if not isinstance(creds.get('password'), str) or len(creds['password']) != 8:
        parser.error('Expected an eight-character relay password supplied privately on stdin')
    viewer = Viewer(args.host, creds['port'], creds['password'])
    try:
        data = measure(viewer, args.samples)
    finally:
        viewer.close()
print(json.dumps(data, indent=2))
