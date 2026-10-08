import re, os, pty, sys, time, select, struct, fcntl, termios, pyte

S = sys.argv[1]
ROWS, COLS = 24, 90
env = dict(os.environ, TYMLEE_HOME=f"{S}/cli-home-pty", EDITOR=f"{S}/fake-editor.sh", TERM="xterm-256color")
os.system(f"rm -rf {S}/cli-home-pty")

screen = pyte.Screen(COLS, ROWS)
stream = pyte.ByteStream(screen)

pid, fd = pty.fork()
if pid == 0:
    os.execvpe("node", ["node", "cli/tymlee.js"], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

def pump(seconds=0.6):
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return
            # Answer the cursor-position query like a real terminal would.
            if b"\x1b[6n" in data:
                os.write(fd, f"\x1b[{screen.cursor.y + 1};{screen.cursor.x + 1}R".encode())
            stream.feed(data)

def send(keys, wait=0.6):
    os.write(fd, keys.encode())
    pump(wait)

def lines():
    return [l.rstrip() for l in screen.display]

def show(title):
    print(f"--- {title}")
    for i, l in enumerate(lines()):
        print(f"{i+1:2}|{l}")

ok_count = 0
def ok(cond, msg):
    global ok_count
    print(("PASS " if cond else "FAIL ") + msg)
    ok_count += cond

pump(2.0)
ok(any(re.search(r"tymlee v\d+\.\d+\.\d+( \([0-9a-f]{7}\))? · type what you are starting", l) for l in lines()), "banner shown, with the version")
ok("not clocked in" in lines()[-1], f"status line on the bottom row: {lines()[-1]!r}")

send("dev fixing the login bug\r")
send("mtg standup\r")
send("dev code review\r", 1.2)
last = lines()[-1]
ok("▶ 0:00:0" in last and "dev code review" in last and "local" in last, f"status line updates: {last!r}")

# Tab completion: "m" + Tab -> "mtg "
send("m\t", 0.5)
ok(any(l.endswith("> mtg") or l.endswith("> mtg ") for l in lines()), "Tab completes a category")
send("\x15", 0.3)  # Ctrl+U clears the line

# Status line keeps ticking.
before = lines()[-1]; pump(1.5); after = lines()[-1]
ok(before != after and "▶" in after, "the timer ticks")

# /edit in $EDITOR (the fake editor renames mtg standup -> mtg planning)
send("/edit\r", 1.5)
ok(any("saved: 1 changed" in l for l in lines()), "/edit applies what the editor saved")
send("/log\r", 0.8)
ok(any("planning" in l for l in lines()), "/log shows the edit")
ok("dev code review" in lines()[-1], "status line still there after the editor")

# Filling the screen scrolls the output but not the status line.
for i in range(15):
    send(f"/whoami\r", 0.15)
pump(0.8)
ok("dev code review" in lines()[-1] and "local" in lines()[-1], "status line stays put while output scrolls")
ok(lines()[-2].startswith(">"), f"prompt sits just above the status line: {lines()[-2]!r}")

# Up arrow recalls history
send("\x1b[A", 0.4)
ok(lines()[-2].startswith("> /whoami"), "Up recalls the previous input")
ok("local" in lines()[-1], "status line survives recalling history")
send("\x15", 0.2)
ok("local" in lines()[-1], "status line survives clearing the line")

show("screen before quitting")
send("\x04", 1.5)  # Ctrl+D
try:
    _, status = os.waitpid(pid, 0)
    ok(os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0, "Ctrl+D quits cleanly")
except ChildProcessError:
    ok(True, "Ctrl+D quits cleanly")
ok(os.path.exists(f"{S}/cli-home-pty/history"), "history saved")
print(f"{ok_count} passed")
