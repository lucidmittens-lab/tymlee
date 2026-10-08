import os, pty, sys, time, select, struct, fcntl, termios, pyte, subprocess
S = sys.argv[1]
ROWS, COLS = 24, 100
home = f"{S}/cli-home-pay"
os.system(f"rm -rf {home}"); os.makedirs(home)
open(f"{home}/config.json", "w").write('{"supabaseUrl": "", "supabaseAnonKey": ""}')
env = dict(os.environ, TYMLEE_HOME=home, TERM="xterm-256color")
run = lambda *a: subprocess.run(["node", "cli/tymlee.js", *a], env=env, capture_output=True, text=True).stdout
n = 0; fails = 0
def ok(c, m):
    global n, fails; print(("PASS " if c else "FAIL ") + m); n += bool(c); fails += (not c)
run("dev", "work")
ok("rate: $60.00 an hour" in run("/rate", "60"), "one-shot /rate 60")
ok("overtime after 40 hours" in run("/otmin", "40"), "one-shot /otmin 40")
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
pump(3)
st = screen.display[-1]
ok("$" in st and "dev work" in st and "today" in st, f"status line shows pay: {st.rstrip()!r}")
os.write(fd, b"\x04"); pump(1)
sys.exit(1 if fails else 0)
