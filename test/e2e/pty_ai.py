import os, pty, sys, time, select, struct, fcntl, termios, pyte, subprocess, json
S = sys.argv[1]
ROWS, COLS = 34, 110
home = f"{S}/cli-home-ai"
os.system(f"rm -rf {home}"); os.makedirs(home)
open(f"{home}/config.json", "w").write('{"supabaseUrl": "", "supabaseAnonKey": ""}')
env = dict(os.environ, TYMLEE_HOME=home, TERM="xterm-256color", ANTHROPIC_BASE_URL="http://127.0.0.1:8199")
env.pop("TYMLEE_CLIENT_MODULE", None)
run = lambda *a: subprocess.run(["node", "cli/tymlee.js", *a], env=env, capture_output=True, text=True).stdout
n = 0; f = 0
def ok(c, m):
    global n, f; print(("PASS " if c else "FAIL ") + m); n += c; f += (not c)
fake = subprocess.Popen(["node", f"{S}/fake-anthropic.js", f"{S}/fake-anthropic-last.json"], stdout=subprocess.PIPE)
time.sleep(0.6)
ok("API key sk-ant-…wxyz saved" in run("/aikey", "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVwxyz"), "one-shot /aikey")
ok("run it from the tymlee shell" in run("/ai", "9-11", "SP"), "one-shot /ai says to use the shell")
open(f"{S}/sched.pdf", "wb").write(b"%PDF-1.4 fake schedule")
open(f"{S}/take.wav", "wb").write(b"RIFF")
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
send(f"/ai {S}/take.wav hi\r", 1)
ok(any("take.wav: tymlee can't read this kind of file" in l for l in lines()), "an audio file is refused")
send(f"/ai {S}/nothere.pdf hi\r", 1)
ok(any("could not find" in l and "nothere.pdf" in l for l in lines()), "a missing file is named")
send(f"/ai {S}/sched.pdf {S}/fix-notes.docx link the work orders\r", 2.5)
txt = "\n".join(lines())
ok("asking Claude Opus 5.5 about sched.pdf, fix-notes.docx" in txt and "+ 09:00  NORTHSTAR mix revisions" in txt and "link [4471] → NORTHSTAR" in txt, "preview in the terminal")
ok(any(l.startswith("apply ›") for l in lines()), "asks apply ›")
last = json.load(open(f"{S}/fake-anthropic-last.json"))
ok(last["url"].startswith("/v1/messages") and last["body"]["messages"][0]["content"][0]["type"] == "document" and last["body"]["messages"][0]["content"][1]["source"] == {"type": "text", "media_type": "text/plain", "data": "Session notes: ZENITH conform"} and last["headers"].get("x-api-key") == "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVwxyz", "the terminal sends the PDF and the Word text with the key")
send("y\r", 1.2)
ok(any("applied 2 changes" in l for l in lines()), "applied")
send("/wolist\r", 0.8)
ok(any("[4471]" in l for l in lines()), "the work order is linked")
send("\x04", 1.2)
fake.terminate()
print(f"{n} passed, {f} failed")
