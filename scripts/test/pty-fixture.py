import fcntl
import json
import os
import pty
import select
import struct
import termios

pairs = [pty.openpty() for _ in range(3)]
for master, slave in pairs:
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 60, 160, 1280, 960))
print(json.dumps([os.ttyname(slave) for master, slave in pairs]), flush=True)
while True:
    ready, _, _ = select.select([master for master, slave in pairs] + [0], [], [])
    if 0 in ready and not os.read(0, 1024):
        break
    for master in ready:
        if master:
            os.read(master, 1024 * 1024)
