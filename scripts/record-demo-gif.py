#!/usr/bin/env python3
"""Record the pi TUI (with this repo's extension) into demo footage.

Phases compose freely — a bad model take never forces a re-render:

  record   pty-spawn `pi -ne -e packages/entry/dist/index.js` in an isolated
           PI_CODING_AGENT_DIR (credentials copied, no personal skill
           warnings on screen), inject one prompt + CR, save timestamped
           bytes (--bytes to keep several takes apart)
  render   pyte-replay -> dedupe frames -> PIL-render PNGs (Menlo + CJK
           fallback) -> ffmpeg. Either a plain --from/--to window, or a
           --scenes JSON timeline with title cards and per-scene speed:
             {"scenes":[
               {"card": ["pi-ptc-subagents", "一个程序，批量调工具"], "hold": 2},
               {"src": [3, 40], "speed": 2.5},
               {"card": ["16 次 read = 16 个结果进上下文"], "hold": 2.5}]}
           Cards render at 1600x1024; each emitted frame plays 1/fps s,
           so src scenes sample at (1/fps)*speed intervals.
  cast     bytes -> asciinema v3 cast (noise events dropped), for agg

Usage:
  python3 scripts/record-demo-gif.py record [--prompt-file f] [--bytes f]
  python3 scripts/record-demo-gif.py render [--scenes s.json | --from s --to s]
                                            [--fps n] [--mp4] [-o out]

shortcut: one-off marketing asset generator, not wired into CI;
upgrade if demos need to be re-cut per release.
"""

import argparse
import fcntl
import json
import os
import pty
import select
import shutil
import struct
import subprocess
import sys
import termios
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENTRY = os.path.join(REPO, "packages", "entry", "dist", "index.js")
AGENT_DIR = "/tmp/ptc-demo-agent"
BYTES = "/tmp/ptc-demo-bytes.bin"
FRAMES = "/tmp/ptc-demo-frames"
COLS, ROWS = 100, 32
SCALE = 2

DEFAULT_PROMPT = (
    "用 ptc_run_code 一次完成：统计 src 下每个 ts 文件的行数，"
    "按文件归约成清单返回。不要逐条调用工具。"
)


def prep_agent_dir():
    os.makedirs(AGENT_DIR, exist_ok=True)
    src = os.path.join(os.path.expanduser("~"), ".pi", "agent")
    for name in ("auth.json", "models.json", "models-store.json"):
        f = os.path.join(src, name)
        if os.path.exists(f):
            shutil.copyfile(f, os.path.join(AGENT_DIR, name))


def record(args):
    prompt = args.prompt
    if args.prompt_file:
        with open(args.prompt_file, encoding="utf-8") as f:
            prompt = f.read().strip()
    if not prompt.endswith("\n"):
        prompt += "\n"

    prep_agent_dir()
    os.makedirs(args.home, exist_ok=True)  # no user-level skills / config

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor",
               PI_CODING_AGENT_DIR=AGENT_DIR, HOME=args.home,
               NODE_NO_WARNINGS="1")
    if args.shell:
        cmd = [args.shell]
    else:
        cmd = ["pi", "-ne", "-e", ENTRY]
    proc = subprocess.Popen(
        cmd,
        stdin=slave, stdout=slave, stderr=slave,
        cwd=args.cwd, env=env, close_fds=True,
    )
    os.close(slave)

    chunks = []  # (t, bytes)
    start = time.monotonic()
    sent_prompt = False
    trusted = False

    def feed(data):
        os.write(master, data.encode())

    try:
        while True:
            now = time.monotonic() - start
            if not sent_prompt and now >= args.prompt_at:
                # paste the prompt slowly (the TUI reads keystrokes), then CR
                for i in range(0, len(prompt), 12):
                    feed(prompt[i:i + 12])
                    time.sleep(0.05)
                feed("\r")
                sent_prompt = True
            if now > args.timeout:
                print(f"timeout after {args.timeout}s, collecting", file=sys.stderr)
                break
            if proc.poll() is not None:
                print("pi exited", file=sys.stderr)
                break
            r, _, _ = select.select([master], [], [], 0.1)
            if r:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                if not data:
                    break
                chunks.append((now, data))
                if not trusted and b"Trust project folder?" in data:
                    feed("\r")
                    trusted = True
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        os.close(master)

    with open(args.bytes, "wb") as f:
        for t, data in chunks:
            f.write(struct.pack("<d", t))
            f.write(struct.pack("<I", len(data)))
            f.write(data)
    total = sum(len(d) for _, d in chunks)
    print(f"recorded {len(chunks)} chunks, {total} bytes, "
          f"{chunks[-1][0] if chunks else 0:.1f}s -> {args.bytes}")


def load_chunks(path=BYTES):
    chunks = []
    with open(path, "rb") as f:
        while True:
            head = f.read(12)
            if len(head) < 12:
                break
            t, n = struct.unpack("<dI", head)
            chunks.append((t, f.read(n)))
    return chunks


CJK_RANGES = ((0x2E80, 0x9FFF), (0xF900, 0xFAFF), (0xFF00, 0xFFEF),
              (0x20000, 0x2FA1F))


def is_cjk(ch):
    o = ord(ch)
    return any(lo <= o <= hi for lo, hi in CJK_RANGES)


def render(args):
    import pyte
    from PIL import Image, ImageDraw, ImageFont

    screen = pyte.Screen(COLS, ROWS)
    stream = pyte.ByteStream(screen)
    font = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 13 * SCALE)
    cjk_font = ImageFont.truetype(
        "/System/Library/Fonts/Hiragino Sans GB.ttc", 12 * SCALE)
    cw = font.getlength("M")
    ascent, descent = font.getmetrics()
    lh = ascent + descent

    palette = {
        "black": "#1e1e1e", "red": "#f14c4c", "green": "#23d18b",
        "yellow": "#f5f543", "blue": "#3b8eea", "magenta": "#d670d6",
        "cyan": "#29b8db", "white": "#e5e5e5", "default": "#e5e5e5",
    }
    bright = {
        "black": "#666666", "red": "#f14c4c", "green": "#23d18b",
        "yellow": "#f5f543", "blue": "#569cd6", "magenta": "#d670d6",
        "cyan": "#29b8db", "white": "#ffffff", "default": "#ffffff",
    }

    def cell_fg(c):
        if c.fg == "default":
            return palette["default"]
        table = bright if getattr(c, "bold", False) else palette
        return table.get(c.fg, palette["default"])

    def cell_bg(c):
        if c.bg == "default":
            return palette["black"]
        return palette.get(c.bg, palette["black"])

    def snapshot():
        img = Image.new("RGB", (int(cw * COLS), int(lh * ROWS)),
                        palette["black"])
        draw = ImageDraw.Draw(img)
        skip = set()  # second half of a double-width CJK cell
        for y in range(ROWS):
            line = screen.buffer.get(y, {})
            row_text = "".join(c.data for c in line.values())
            if "ExperimentalWarning" in row_text or "trace-warnings" in row_text:
                continue  # status-bar noise from the TS-strip worker, not demo
            for x in range(COLS):
                if (x, y) in skip:
                    continue
                c = line.get(x)
                if c is None or c.data == " ":
                    continue
                if c.bg != "default":
                    w = 2 if is_cjk(c.data) else 1
                    draw.rectangle(
                        [x * cw, y * lh, (x + w) * cw - 1, (y + 1) * lh - 1],
                        fill=cell_bg(c))
                if is_cjk(c.data):
                    draw.text((x * cw - 1, y * lh + 1), c.data,
                              font=cjk_font, fill=cell_fg(c))
                    skip.add((x + 1, y))
                else:
                    draw.text((x * cw, y * lh), c.data, font=font,
                              fill=cell_fg(c))
        return img

    def render_card(lines):
        img = Image.new("RGB", (int(cw * COLS), int(lh * ROWS)), "#000000")
        draw = ImageDraw.Draw(img)
        for cand in ("/System/Library/Fonts/SFNS.ttf",
                     "/System/Library/Fonts/Helvetica.ttc"):
            try:
                big = ImageFont.truetype(cand, 54)
                small = ImageFont.truetype(cand, 30)
                break
            except OSError:
                continue
        total_h = 0
        sizes = []
        for i, ln in enumerate(lines):
            f = small if i == 0 and len(lines) > 1 else big
            bbox = draw.textbbox((0, 0), ln, font=f)
            sizes.append((f, bbox[3] - bbox[1]))
            total_h += bbox[3] - bbox[1] + 34
        y = (int(lh * ROWS) - total_h) // 2
        for i, ln in enumerate(lines):
            f, h = sizes[i]
            color = "#86868b" if i == 0 and len(lines) > 1 else "#f5f5f7"
            w = draw.textlength(ln, font=f)
            draw.text(((int(cw * COLS) - w) // 2, y), ln, font=f, fill=color)
            y += h + 34
        return img

    # Build the plan: [(kind, payload, hold_or_speed, src_file)]
    plan = []
    if args.scenes:
        with open(args.scenes, encoding="utf-8") as f:
            for scene in json.load(f)["scenes"]:
                if "card" in scene:
                    lines = scene["card"]
                    if isinstance(lines, str):
                        lines = [lines]
                    plan.append(("card", lines, scene.get("hold", 2.0), None, 0))
                else:
                    plan.append(("src", tuple(scene["src"]),
                                 scene.get("speed", 1.0),
                                 scene.get("src_file", args.bytes),
                                 scene.get("hold_last", 0)))
    else:
        lo = args.frm if args.frm is not None else 0
        hi = args.to if args.to is not None else float("inf")
        plan.append(("src", (lo, hi), 1.0, args.bytes, 0))

    def render_src_scene(lo, hi, speed, src_file, hold_last=0):
        """Replay one recording in isolation; sample its [lo,hi] window."""
        scr = pyte.Screen(COLS, ROWS)
        st = pyte.ByteStream(scr)

        def snap():
            img = Image.new("RGB", (int(cw * COLS), int(lh * ROWS)),
                            palette["black"])
            draw = ImageDraw.Draw(img)
            skip = set()
            for y in range(ROWS):
                line = scr.buffer.get(y, {})
                row_text = "".join(c.data for c in line.values())
                if ("ExperimentalWarning" in row_text
                        or "trace-warnings" in row_text
                        or " any time" in row_text):
                    continue
                if "任务面" in row_text or "surface=full_ptc" in row_text:
                    continue  # product status line is Chinese-only; drop it
                if ("default interactive shell" in row_text
                        or "To update your account" in row_text
                        or "support.apple.com" in row_text):
                    continue  # macOS login banner noise
                if args.cwd_label and row_text.lstrip().startswith("/"):
                    draw.text((0, y * lh), args.cwd_label, font=font,
                              fill="#9a9a9e")
                    continue
                for x in range(COLS):
                    if (x, y) in skip:
                        continue
                    c = line.get(x)
                    if c is None or c.data == " ":
                        continue
                    if c.bg != "default":
                        w = 2 if is_cjk(c.data) else 1
                        draw.rectangle(
                            [x * cw, y * lh, (x + w) * cw - 1,
                             (y + 1) * lh - 1], fill=cell_bg(c))
                    if is_cjk(c.data):
                        draw.text((x * cw - 1, y * lh + 1), c.data,
                                  font=cjk_font, fill=cell_fg(c))
                        skip.add((x + 1, y))
                    else:
                        draw.text((x * cw, y * lh), c.data, font=font,
                                  fill=cell_fg(c))
            return img

        step = (1.0 / args.fps) * speed
        nxt = lo
        out = []
        prev = None
        t0 = None
        for t, data in load_chunks(src_file):
            if t0 is None:
                t0 = t
            el = t - t0
            st.feed(data)
            while nxt <= el and nxt <= hi:
                img = snap()
                key = img.tobytes()
                if out and prev == key:
                    out[-1] = (out[-1][0], out[-1][1] + 1)
                else:
                    p = f"{FRAMES}/{os.path.basename(src_file)}_{lo:g}_{len(out):04d}.png"
                    img.save(p)
                    out.append((p, 1))
                    prev = key
                nxt += step
            if el > hi:
                break
        if out and hold_last:
            out.append((out[-1][0], int(hold_last * args.fps)))
        return out

    os.makedirs(FRAMES, exist_ok=True)
    for old in os.listdir(FRAMES):
        p = os.path.join(FRAMES, old)
        shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)

    # Playback order follows the plan (cards interleaved); keep per-scene
    # segments — the image concat demuxer mangles per-file durations, so MP4
    # is built per segment and concatenated as real video; GIF gets one
    # concat line per frame at a fixed duration.
    segments = []  # [[(png_path, repeat), ...], ...] per scene
    card_cache = {}
    for idx, (kind, payload, third, src_file, hold_last) in enumerate(plan):
        if kind == "card":
            cache_key = "\n".join(payload)
            if cache_key not in card_cache:
                img = render_card(payload)
                p = f"{FRAMES}/card{idx}.png"
                img.save(p)
                card_cache[cache_key] = p
            segments.append([(card_cache[cache_key],
                              max(1, int(third * args.fps)))])
        else:
            segments.append(
                render_src_scene(*payload, third, src_file, hold_last))

    total_frames = sum(rep for seg in segments for _, rep in seg)
    if total_frames == 0:
        print("no frames emitted", file=sys.stderr)
        sys.exit(1)
    total_s = total_frames / args.fps

    out = args.out
    if args.mp4:
        seg_files = []
        for si, seg in enumerate(segments):
            if not seg:
                continue
            d = f"{FRAMES}/seg{si:02d}"
            os.makedirs(d, exist_ok=True)
            n = 0
            for p, rep in seg:
                for _ in range(rep):
                    os.link(p, f"{d}/f{n:04d}.png")
                    n += 1
            seg_mp4 = f"{FRAMES}/seg{si:02d}.mp4"
            subprocess.run(
                ["ffmpeg", "-y", "-framerate", str(args.fps),
                 "-i", f"{d}/f%04d.png",
                 "-c:v", "libx264", "-crf", "20", "-preset", "medium",
                 "-pix_fmt", "yuv420p", seg_mp4],
                check=True, capture_output=True)
            seg_files.append(seg_mp4)
        with open(f"{FRAMES}/concat.txt", "w") as f:
            for p in seg_files:
                f.write(f"file '{p}'\n")
        subprocess.run(
            ["ffmpeg", "-y", "-f", "concat", "-safe", "0",
             "-i", f"{FRAMES}/concat.txt",
             "-c", "copy", "-movflags", "+faststart", out],
            check=True, capture_output=True)
    else:
        with open("/tmp/ptc-demo-list.txt", "w") as f:
            for seg in segments:
                for p, rep in seg:
                    for _ in range(rep):
                        f.write(f"file '{p}'\nduration {1.0/args.fps:.4f}\n")
        subprocess.run(
            ["ffmpeg", "-y", "-f", "concat", "-safe", "0",
             "-i", "/tmp/ptc-demo-list.txt",
             "-vf", f"scale=1000:-1:flags=lanczos,"
                    f"split[s0][s1];[s0]palettegen=max_colors=256[p];"
                    f"[s1][p]paletteuse=dither=none",
             "-loop", "0", out],
            check=True, capture_output=True)
    size = os.path.getsize(out)
    print(f"{out}: {total_frames} frames, {total_s:.1f}s, {size/1e6:.2f} MB")


def to_cast(args):
    out = args.out
    lines = []
    t0 = None
    dropped = 0
    for t, data in load_chunks(args.bytes):
        if t0 is None:
            t0 = t
        el = t - t0
        if args.frm is not None and el < args.frm:
            continue
        if args.to is not None and el > args.to:
            break
        if b"ExperimentalWarning" in data or b"trace-warnings" in data:
            dropped += 1  # worker-spawn noise the host TUI overwrites anyway
            continue
        lines.append([round(el, 6), "o", data.decode("utf-8", errors="replace")])
    with open(out, "w", encoding="utf-8") as f:
        f.write(json.dumps({"version": 3,
                            "term": {"name": "xterm-256color", "cols": COLS,
                                     "rows": ROWS},
                            "timestamp": int(time.time()),
                            "env": {"TERM": "xterm-256color"}}) + "\n")
        for line in lines:
            f.write(json.dumps(line, ensure_ascii=False) + "\n")
    print(f"{out}: {len(lines)} events ({dropped} noise events dropped)")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    pr = sub.add_parser("record")
    pr.add_argument("--prompt", default=DEFAULT_PROMPT)
    pr.add_argument("--prompt-file")
    pr.add_argument("--prompt-at", type=float, default=3.0,
                    help="seconds before typing the prompt")
    pr.add_argument("--timeout", type=float, default=150)
    pr.add_argument("--bytes", default=BYTES)
    pr.add_argument("--cwd", default=REPO)
    pr.add_argument("--home", default="/tmp/ptc-demo-home",
                    help="fake HOME so user-level skills/config stay off-screen")
    pr.add_argument("--shell", default=None,
                    help="record a bare shell instead of pi (engine demos)")
    pr.set_defaults(fn=record)

    rd = sub.add_parser("render")
    rd.add_argument("--bytes", default=BYTES)
    rd.add_argument("--scenes", default=None,
                    help="JSON timeline with cards + sped src windows")
    rd.add_argument("--cwd-label", default="~/demo",
                    help="replace the status-bar cwd row with this label")
    rd.add_argument("--from", dest="frm", type=float, default=None)
    rd.add_argument("--to", type=float, default=None)
    rd.add_argument("--fps", type=float, default=4.0)
    rd.add_argument("-o", "--out",
                    default=os.path.join(REPO, "docs", "assets",
                                         "ptc-demo.gif"))
    rd.add_argument("--mp4", action="store_true",
                    help="true-color H.264 instead of a palette GIF")
    rd.set_defaults(fn=render)

    sc = sub.add_parser("cast", help="bytes -> asciinema v3 cast")
    sc.add_argument("--bytes", default=BYTES)
    sc.add_argument("-o", "--out", default="/tmp/ptc-demo.cast")
    sc.add_argument("--from", dest="frm", type=float, default=None)
    sc.add_argument("--to", type=float, default=None)
    sc.set_defaults(fn=to_cast)

    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
