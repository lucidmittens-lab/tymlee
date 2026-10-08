import os, pty, sys, time, select, struct, fcntl, termios, pyte, subprocess
S = sys.argv[1]
ROWS, COLS = 30, 90
home = f"{S}/cli-home-tlp"
os.system(f"rm -rf {home}"); os.makedirs(home)
open(f"{home}/config.json", "w").write('{"supabaseUrl": "", "supabaseAnonKey": ""}')
env = dict(os.environ, TYMLEE_HOME=home, TERM="xterm-256color")
env.pop("TYMLEE_CLIENT_MODULE", None)
run = lambda *a: subprocess.run(["node", "cli/tymlee.js", *a], env=env, capture_output=True, text=True).stdout
n = 0; fails = 0
def ok(c, m):
    global n, fails; print(("PASS " if c else "FAIL ") + m); n += bool(c); fails += (not c)
run("dev", "fixing", "login", "bug")
ok("interactive" in run("/timeline-p"), "one-shot /timeline-p explains it needs the shell")
screen = pyte.Screen(COLS, ROWS); stream = pyte.ByteStream(screen)
pid, fd = pty.fork()
if pid == 0:
    os.execvpe("node", ["node", "cli/tymlee.js"], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
def pump(t=0.5):
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try: data = os.read(fd, 65536)
            except OSError: return
            if b"\x1b[6n" in data: os.write(fd, f"\x1b[{screen.cursor.y+1};{screen.cursor.x+1}R".encode())
            stream.feed(data)
def send(k, t=0.5): os.write(fd, k.encode()); pump(t)
lines = lambda: [l.rstrip() for l in screen.display]
pump(2)
ok(screen.cursor.y == ROWS - 2, f"prompt starts on the bottom row (row {screen.cursor.y})")
ok(any("fixing login bug" in l for l in lines()), "start-up report still visible above it")
send("/timeline-p\r", 0.8)
L = lines()
div = next((i for i, l in enumerate(L) if "/timeline-h hides" in l), -1)
ok(0 < div < 8 and "■ dev" in L[0], f"pinned pane on top with legend, sized to fit: divider at row {div}")
ok(any("██" in l and "fixing login bug" in l for l in L[:div]), "the pane shows the running block")
ok(screen.cursor.y == ROWS - 2, f"prompt on the bottom row after pinning (row {screen.cursor.y})")
send("mtg standup\r", 0.8)
L = lines()
div = next((i for i, l in enumerate(L) if "/timeline-h hides" in l), -1)
ok(any("██" in l and "mtg" in l for l in L[:div]), "a new entry shows up in the pane live")
for i in range(25): send(f"/help\r", 0.05)
pump(1)
L = lines()
ok("■ dev" in L[0] and "/timeline-h hides" in L[div], "the pane stays put while output scrolls")
ok("today" in L[-1] or "mtg" in L[-1], f"status line intact: {L[-1]!r}")
send("/undo\r", 0.8)
div2 = next((i for i, l in enumerate(lines()) if "/timeline-h hides" in l), -1)
ok(div2 < div, f"the pane shrinks back ({div} -> {div2})")
ok(not any("mtg" in l and "██" in l for l in lines()[:div]), "undo updates the pane")
send("/clear\r", 0.8)
L = lines()
ok("■ dev" in L[0] and screen.cursor.y == ROWS - 2, f"/clear keeps the pane and puts the prompt at the bottom (row {screen.cursor.y})")
send("/timeline-h\r", 0.8)
L = lines()
ok(not any("/timeline-h hides" in l for l in L) and not L[0].startswith("■"), "/timeline-h hides it")
ok(any("timeline hidden" in l for l in L), "and says so")
send("/timeline-h\r", 0.6); ok(any("not pinned" in l for l in lines()), "hiding twice explains")
send("/clear\r", 0.6); ok(screen.cursor.y == ROWS - 2, f"/clear without the pane: prompt at the bottom (row {screen.cursor.y})")
send("\x0c", 0.6); ok(screen.cursor.y == ROWS - 2 and "today" in lines()[-1], f"Ctrl+L: prompt at the bottom, status kept (row {screen.cursor.y})")
send("/timeline-p week\r", 0.8); ok(any("timeline · week" in l for l in lines()), "/timeline-p week")
send("/timeline-p nonsense\r", 0.6); ok(any('unknown range "nonsense"' in l for l in lines()), "bad range explained")
open(f"{S}/pty-tl.txt", "w").write("\n".join(lines()))
send("\x04", 1.2)
print(f"{n} passed")
sys.exit(1 if fails else 0)
