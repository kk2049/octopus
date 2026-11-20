/**
 * The guest session launcher, run by `python3 -I` as the owner's own user.
 * It is Python because Node has no PTY. See the docstring for the stdin/stdout contract.
 */
export const GUEST_LAUNCHER_PY = String.raw`"""Octopus guest session launcher (2026-11-13).

The owner's Runner starts this as the owner's own user:

    python3 -I <this file>

stdin carries frames, each [type u8][length u32 big-endian][payload]:
  3 SPEC    first frame, JSON: files, environment, command
  1 DATA    bytes typed at the guest's terminal
  2 RESIZE  JSON {"cols": c, "rows": r}
stdout carries the terminal's output, unframed. The exit status is the
command's (or 125 when the session could not be set up).

There is no sandbox here. The guest's agent is kept to its own directory by
its system prompt and by a PreToolUse guard hook (guest-guard-script.ts).
"""
import errno
import fcntl
import json
import os
import select
import signal
import struct
import sys
import termios

FRAME_DATA, FRAME_RESIZE, FRAME_SPEC = 1, 2, 3
SETUP_FAILED = 125

class SetupError(Exception):
    pass


def inside(home, relative):
    path = os.path.normpath(os.path.join(home, relative))
    if os.path.isabs(relative) or path != home and not path.startswith(home + os.sep):
        raise SetupError("path escapes the guest home: " + relative)
    return path


def prepare(spec):
    home = spec["home"]
    for relative in spec.get("dirs", []):
        os.makedirs(inside(home, relative), mode=0o700, exist_ok=True)
    for entry in spec.get("files", []):
        path = inside(home, entry["path"])
        if entry.get("create_only") and os.path.lexists(path):
            continue
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        temp = "%s.octopus-%d" % (path, os.getpid())
        with open(os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, entry.get("mode", 0o600)), "w",
                  encoding="utf-8") as handle:
            handle.write(entry["text"])
        os.replace(temp, path)
    for entry in spec.get("links", []):
        path = inside(home, entry["path"])
        if not os.path.lexists(path):
            os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
            os.symlink(entry["target"], path)


def read_exact(fd, size):
    data = b""
    while len(data) < size:
        chunk = os.read(fd, size - len(data))
        if not chunk:
            raise EOFError
        data += chunk
    return data


def write_all(fd, data):
    view = memoryview(data)
    while view:
        try:
            view = view[os.write(fd, view):]
        except InterruptedError:
            continue


def set_size(fd, cols, rows):
    cols = max(1, min(int(cols), 1000))
    rows = max(1, min(int(rows), 1000))
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def spawn(spec):
    master, slave = os.openpty()
    set_size(master, spec.get("cols", 80), spec.get("rows", 24))
    pid = os.fork()
    if pid == 0:
        try:
            os.close(master)
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
            for fd in (0, 1, 2):
                os.dup2(slave, fd)
            if slave > 2:
                os.close(slave)
            os.execvpe(spec["argv"][0], spec["argv"], spec["env"])
        except BaseException as error:  # noqa: BLE001 - report anything and never return into the relay
            os.write(2, ("octopus: cannot start %s: %s\r\n" % (spec["argv"][0], error)).encode())
        os._exit(127)
    os.close(slave)
    return pid, master


def relay(pid, master):
    os.set_blocking(master, False)
    pending = b""      # input waiting for the terminal
    frames = b""       # partial frames from the Runner
    stdin_open = True
    while True:
        readers = [master] + ([0] if stdin_open and len(pending) < (1 << 20) else [])
        writers = [master] if pending else []
        try:
            readable, writable, _ = select.select(readers, writers, [])
        except InterruptedError:
            continue
        if master in readable:
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break  # the command and everything on the terminal are gone
                raise
            if not data:
                break
            try:
                write_all(1, data)
            except BrokenPipeError:
                stdin_open = False
                os.kill(pid, signal.SIGHUP)
        if master in writable and pending:
            try:
                written = os.write(master, pending)
                pending = pending[written:]
            except BlockingIOError:
                pass
        if stdin_open and 0 in readable:
            chunk = os.read(0, 65536)
            if not chunk:
                # The guest disconnected: a hung-up terminal makes tmux detach.
                stdin_open = False
                os.kill(pid, signal.SIGHUP)
                continue
            frames += chunk
            while len(frames) >= 5:
                kind, size = struct.unpack(">BI", frames[:5])
                if size > (4 << 20):
                    raise SetupError("frame too large")
                if len(frames) < 5 + size:
                    break
                payload, frames = frames[5:5 + size], frames[5 + size:]
                if kind == FRAME_DATA:
                    pending += payload
                elif kind == FRAME_RESIZE:
                    size_spec = json.loads(payload)
                    set_size(master, size_spec["cols"], size_spec["rows"])
    _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status)


def main():
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    try:
        kind, size = struct.unpack(">BI", read_exact(0, 5))
        if kind != FRAME_SPEC or size > (1 << 20):
            raise SetupError("the first frame must be the session spec")
        spec = json.loads(read_exact(0, size))
        os.umask(0o077)
        prepare(spec)
        if spec.get("nice"):
            os.nice(int(spec["nice"]))
        os.chdir(spec.get("cwd", spec["home"]))
    except (SetupError, OSError, EOFError, KeyError, ValueError) as error:
        sys.stderr.write("octopus guest sandbox: %s\n" % error)
        return SETUP_FAILED
    pid, master = spawn(spec)
    signal.signal(signal.SIGTERM, lambda *_: os.kill(pid, signal.SIGHUP))
    return relay(pid, master)


if __name__ == "__main__":
    sys.exit(main())
`;
