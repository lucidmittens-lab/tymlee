import os, pty, sys, time, select, struct, fcntl, termios, pyte, subprocess
S = sys.argv[1]
ROWS, COLS = 30, 100
home = f"{S}/cli-home-note"
os.system(f"rm -rf {home}")
env = dict(os.environ, TYMLEE_HOME=home, TERM="xterm-256color", TYMLEE_SUPABASE_URL="", TYMLEE_SUPABASE_KEY="")
env.pop("TYMLEE_CLIENT_MODULE", None)
# local-only: point config at nothing
env["TYMLEE_SUPABASE_URL"] = ""
screen = pyte.Screen(COLS, ROWS); stream = pyte.ByteStream(screen)
# seed three entries with one-shot runs (local only: empty config via env override file)
os.makedirs(home, exist_ok=True)
open(f"{home}/config.json", "w").write('{"supabaseUrl": "", "supabaseAnonKey": ""}')
for e in ["dev fixing login bug", "mtg standup", "dev code review"]:
    subprocess.run(["node", "cli/tymlee.js"] + e.split(), env=env, check=True, capture_output=True)
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
def prompt_line(): return lines()[screen.cursor.y]
n = 0
def ok(c, m):
    global n; print(("PASS " if c else "FAIL ") + m); n += c
pump(2)
send("/note\r", 0.8)
ok(prompt_line().startswith("note › ID:000030") and "(1/3)" in prompt_line(), f"picker starts on the newest: {prompt_line()!r}")
send("\t", 0.4); ok(prompt_line().startswith("note › ID:000020"), "Tab: older")
send("\t", 0.4); ok(prompt_line().startswith("note › ID:000010"), "Tab: older again")
send("\x1b[Z", 0.4); ok(prompt_line().startswith("note › ID:000020"), "Shift+Tab: newer")
send("x", 0.3); ok(prompt_line().startswith("note › ID:000020") and not prompt_line().rstrip().endswith("x"), "typing is ignored while choosing")
send("\r", 0.6); ok(prompt_line().startswith("notes ›"), f"then asks for notes: {prompt_line()!r}")
send("ran long", 0.3)
send("\x1b\r", 0.4)
ok(prompt_line().rstrip() == "notes ›" and lines()[screen.cursor.y - 1].rstrip() == "notes › ran long", f"Alt+Enter moves to a new line, doesn't save: {lines()[screen.cursor.y - 1]!r} / {prompt_line()!r}")
send("second line\r", 0.8)
ok(any("notes saved on ID:000020 mtg standup" in l for l in lines()), "notes saved")
send("/log\r", 0.8); ok(any(l.strip() == "> ran long" for l in lines()) and any(l.strip() == "> second line" for l in lines()), "/log shows both lines")
send("/note 20\r", 0.8); ok(prompt_line().rstrip() == "notes ›" and lines()[screen.cursor.y - 2].rstrip() == "notes › ran long" and lines()[screen.cursor.y - 1].rstrip() == "notes › second line", "/note 20 shows the notes so far and starts a new line")
send("third line\r", 0.8)
send("/log\r", 0.8); ok(any(l.strip() == "> third line" for l in lines()), "the new line is added under the others")
send("/note one more thing\r", 0.8); ok(any("notes saved on ID:000030" in l for l in lines()), "/note <text> adds to the current entry")
send("/note ID:000020\r", 0.8); send("\x1b", 1.0); ok(any("note cancelled" in l for l in lines()), "Esc cancels")
ok(prompt_line().startswith(">"), f"back to the normal prompt: {prompt_line()!r}")
send("/report\r", 0.8); ok(any(l.startswith("dev ") and "2 entries" in l for l in lines()), "/report groups by category")
send("\x1b[A", 0.4); ok(prompt_line().startswith("> /report"), "history has commands, not the notes typed")
send("\x15", 0.2)
send("\x04", 1.2)
out = subprocess.run(["node", "cli/tymlee.js", "/note", "ID:000010", "one-shot", "notes"], env=env, capture_output=True, text=True).stdout
ok("notes saved on ID:000010 dev fixing login bug" in out, "one-shot: /note ID:000010 <notes>")
out = subprocess.run(["node", "cli/tymlee.js", "/note"], env=env, capture_output=True, text=True).stdout
ok("use /note #n <notes>" in out, "one-shot /note without a number explains")
out = subprocess.run(["node", "cli/tymlee.js", "/log"], env=env, capture_output=True, text=True).stdout
ok("> one-shot notes" in out and "> second line" in out, "notes kept on disk")
print(f"{n} passed")
