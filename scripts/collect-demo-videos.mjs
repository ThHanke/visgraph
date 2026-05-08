/**
 * After `npm run demo:video`, copies each recorded .webm from
 * test-results/demo/<hash>/ to docs/demo-videos/<name>.webm,
 * where <name> is derived from the spec file: demo-<name>.spec.ts.
 *
 * Old videos are overwritten so docs/demo-videos/ always reflects the
 * latest run.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RESULTS_DIR = path.join(ROOT, 'test-results', 'demo');
const OUTPUT_DIR = path.join(ROOT, 'docs', 'demo-videos');

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Map spec file stem → video name:  demo-advert-intro.spec.ts → advert-intro
const E2E_DIR = path.join(ROOT, 'e2e');
const specNames = fs.readdirSync(E2E_DIR)
  .filter(f => /^demo-.+\.spec\.ts$/.test(f))
  .map(f => f.replace(/^demo-/, '').replace(/\.spec\.ts$/, ''));

if (!fs.existsSync(RESULTS_DIR)) {
  console.error('No test-results/demo/ directory found. Run npm run demo:video first.');
  process.exit(1);
}

// Sort longest-first so pizza-tutorial-chat is claimed before pizza-tutorial
specNames.sort((a, b) => b.length - a.length);

// Pre-assign each result subdir to its longest-matching spec name
const claimedDirs = new Map(); // subdir → name
for (const subdir of fs.readdirSync(RESULTS_DIR)) {
  for (const name of specNames) {
    if (subdir.startsWith(`demo-${name}`) && !claimedDirs.has(subdir)) {
      claimedDirs.set(subdir, name);
      break;
    }
  }
}

let copied = 0;
for (const name of specNames) {
  // Playwright names the output dir: e2e-demo-<name>-<hash>-demo/
  const subdirs = [...claimedDirs.entries()]
    .filter(([, n]) => n === name)
    .map(([d]) => d);

  for (const subdir of subdirs) {
    const videoPath = path.join(RESULTS_DIR, subdir, 'video.webm');
    if (!fs.existsSync(videoPath)) continue;
    const dest = path.join(OUTPUT_DIR, `${name}.webm`);
    fs.copyFileSync(videoPath, dest);
    const size = (fs.statSync(dest).size / 1024).toFixed(0);
    console.log(`✓ docs/demo-videos/${name}.webm  (${size} KB)`);

    // Shorten idle blocks and produce mp4 in one step.
    // Samples at 0.5fps so cursor blinks/CSS animations don't break detection.
    // Only blocks longer than 8s (viewer ingest wait) are shortened to 10s.
    const mp4 = path.join(OUTPUT_DIR, `${name}.mp4`);
    let mp4ok = false;
    try {
      execFileSync('python3', [
        path.join(__dirname, 'shorten-idle.py'),
        dest,          // input webm
        mp4,           // output mp4 directly — libx264, no intermediate webm
        '10.0',        // digest seconds (keep 10s of each idle block)
        '8.0',         // min idle duration to shorten
        '0.5',         // sample fps (1 frame / 2s — ignores sub-2s animations)
        '-30',         // noise floor dB
      ], { stdio: 'inherit' });
      const mp4size = (fs.statSync(mp4).size / 1024).toFixed(0);
      console.log(`✓ docs/demo-videos/${name}.mp4   (${mp4size} KB)`);
      mp4ok = true;
    } catch {
      console.warn(`  shorten-idle.py failed — falling back to plain mp4 conversion`);
    }

    // Fallback: plain webm → mp4 if shorten-idle failed
    if (!mp4ok) {
      try {
        execFileSync('ffmpeg', [
          '-y', '-i', dest,
          '-c:v', 'libx264', '-crf', '20', '-preset', 'slow',
          '-profile:v', 'high', '-level:v', '4.2',
          '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
          mp4,
        ], { stdio: 'pipe' });
        const mp4size = (fs.statSync(mp4).size / 1024).toFixed(0);
        console.log(`✓ docs/demo-videos/${name}.mp4   (${mp4size} KB)  [no idle-trim]`);
      } catch {
        console.warn(`  ffmpeg not found — skipping mp4 conversion for ${name}`);
      }
    }

    copied++;
  }
}

if (copied === 0) {
  console.error('No video files found in test-results/demo/. Did the recording succeed?');
  process.exit(1);
}
