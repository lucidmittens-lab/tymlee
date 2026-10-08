import os, pty, sys, time, select, struct, fcntl, termios, pyte, subprocess
S = sys.argv[1]
ROWS, COLS = 30, 100
home = f"{S}/cli-home-wo"
os.system(f"rm -rf {home}"); os.makedirs(home)
open(f"{home}/config.json", "w").write('{"supabaseUrl": "", "supabaseAnonKey": ""}')
env = dict(os.environ, TYMLEE_HOME=home, TERM="xterm-256color")
env.pop("TYMLEE_CLIENT_MODULE", None)
run = lambda *a: subprocess.run(["node", "cli/tymlee.js", *a], env=env, capture_output=True, text=True).stdout
n = 0
def ok(c, m):
    global n; print(("PASS " if c else "FAIL ") + m); n += c
ok("[4471] linked to dev" in run("/wolink", "dev", "4471"), "one-shot /wolink dev 4471 (before any entries)")
ok("in ID:000010 [4471] dev fixing login bug" in run("dev", "fixing", "login", "bug"), "entry picks up the WO")
run("mtg", "standup")
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
cur = lambda: lines()[screen.cursor.y]
pump(2)
ok(any("[4471]" in l and "fixing login bug" in l for l in lines()), "today's /log on start shows the WO")
send("/wopunch\r", 0.8); ok(cur().startswith("wopunch › ID:000020"), f"/wopunch picker: {cur()!r}")
send("\t", 0.4); ok(cur().startswith("wopunch › ID:000010 [4471]"), "Tab: older, shows the WO")
send("\r", 0.6); ok(cur().startswith("wo › 4471"), f"asks for the WO, pre-filled: {cur()!r}")
send("\x15", 0.2); send("5000\r", 0.8)
ok(any("[5000] set on ID:000010 dev fixing login bug" in l for l in lines()), "punched")
send("/wolink mtg\r", 0.8); send("777\r", 0.8)
ok(any("[777] linked to mtg on" in l and "1 entry updated" in l for l in lines()), "/wolink asks, then links")
ok("[777] mtg standup" in lines()[-1], f"status line shows the WO: {lines()[-1]!r}")
send("/wolist\r", 0.8); ok(any(l.startswith("[5000]") for l in lines()) and any(l.startswith("[777]") for l in lines()), "/wolist")
send("\x04", 1.2)
print(f"{n} passed")
