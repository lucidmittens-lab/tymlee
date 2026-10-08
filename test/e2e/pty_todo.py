import os, pty, sys, time, select, struct, fcntl, termios, pyte, subprocess
S = sys.argv[1]
ROWS, COLS = 30, 110
home = f"{S}/cli-home-todo"
os.system(f"rm -rf {home}"); os.makedirs(home)
open(f"{home}/config.json", "w").write('{"supabaseUrl": "", "supabaseAnonKey": ""}')
env = dict(os.environ, TYMLEE_HOME=home, TERM="xterm-256color")
env.pop("TYMLEE_CLIENT_MODULE", None)
run = lambda *a: subprocess.run(["node", "cli/tymlee.js", *a], env=env, capture_output=True, text=True).stdout
n = 0; f = 0
def ok(c, m):
    global n, f; print(("PASS " if c else "FAIL ") + m); n += c; f += (not c)
run("/todo", "NORTHSTAR", "send", "the", "stems", "due:today")
run("/todo", "ACME", "call", "about", "the", "drawings")
ok("did you mean /todo or /todos?" in run("/tods"), "one-shot did-you-mean")
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
ok("1 due" in lines()[-1], f"status line counts the due to-do: {lines()[-1]!r}")
send("/do draw\t", 0.6)
ok(cur().endswith("/do 20"), f"Tab on a word completes the to-do: {cur()!r}")
send("\r", 0.8)
ok("TD:000020" in lines()[-1], f"status line shows the linked to-do: {lines()[-1]!r}")
send("/done ", 0.2); send("\t", 0.6)
ok(any("/done 10" in l and "send the stems" in l for l in lines()) and any("/done 20" in l and "call about" in l for l in lines()), "several to-dos: each listed with its text")
send("\x15", 0.2); send("/help todo\r", 0.8)
ok(any(l.startswith("To-dos and checklists:") for l in lines()), "/help todo")
send("\x04", 1.2)
print(f"{n} passed, {f} failed")
