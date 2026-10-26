// build-apk.js — packages the static site into an Android APK with hbh-web2app.
// Run with: npm run build-apk   (or: node build-apk.js)
'use strict';

const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');
// archiver@8 is pure ESM and exports classes rather than a callable factory,
// so require() gives { Archiver, ZipArchive, ... } and ZipArchive is used directly.
const { ZipArchive } = require('archiver');
const { GenerateApp } = require('hbh-web2app');

const APP_NAME = 'Expenses';
const PACKAGE_NAME = 'com.yourname.expenses'; // replace "yourname"
const SOURCE_DIR = __dirname;                  // folder containing index.html
const WWW_DIR = path.join(__dirname, 'www');
const OUTPUT_DIR = path.join(__dirname, 'output');
const ICON_PATH = path.join(__dirname, 'icon.png');

// The WebView template ships only as a zip, and hbh-web2app's setupWorkflow calls
// fs.createReadStream(template) unconditionally (app/helpers/unzip.js). Passing a
// *directory* as `template` therefore fails with EISDIR. So the bridge is patched
// into a working copy which is re-zipped, and only the .zip path is handed to
// GenerateApp. node_modules itself is never modified (npm install would wipe it).
const TEMPLATE_SRC = path.join(__dirname, 'node_modules', 'hbh-web2app', 'templates', 'webview.zip');
const BUILD_DIR = path.join(__dirname, '.build');
const TEMPLATE_WORK_DIR = path.join(BUILD_DIR, 'template');
const TEMPLATE_ZIP = path.join(BUILD_DIR, 'webview-patched.zip');
const MAIN_ACTIVITY_REL = path.join('app', 'src', 'main', 'java', 'hbh', 'hub', 'webviewtemplate', 'MainActivity.java');
const BRIDGE_SNIPPET = path.join(__dirname, 'android', 'csv-bridge.java.in');

const BRIDGE_IMPORTS = [
  'import android.annotation.SuppressLint;',
  'import android.content.ContentValues;',
  'import android.provider.MediaStore;',
  'import android.webkit.JavascriptInterface;',
  'import java.io.File;',
  'import java.io.FileOutputStream;',
  'import java.io.OutputStream;',
  'import java.nio.charset.StandardCharsets;'
].join('\n');

// Only these files should end up inside the APK. Kept as an explicit list so
// node_modules, package.json, build-apk.js and output/ are never bundled.
const INCLUDE = ['index.html'];

function copyWebsite() {
  fs.rmSync(WWW_DIR, { recursive: true, force: true });
  fs.mkdirSync(WWW_DIR, { recursive: true });

  for (const file of INCLUDE) {
    const from = path.join(SOURCE_DIR, file);
    if (!fs.existsSync(from)) {
      throw new Error(`Missing required file: ${file}`);
    }
    fs.copyFileSync(from, path.join(WWW_DIR, file));
  }
  console.log(`[build-apk] Copied ${INCLUDE.join(', ')} -> www/`);
}

// Replaces `anchor` exactly once. A missing or duplicated anchor means the
// template changed, which must fail loudly rather than ship a half-patched app.
function injectOnce(source, anchor, replacement, label) {
  const first = source.indexOf(anchor);
  if (first === -1) {
    throw new Error(
      `Template patch failed (${label}): anchor not found.\n` +
        `Expected to find: ${anchor.trim().split('\n')[0]}\n` +
        'The hbh-web2app template has probably changed; update build-apk.js.'
    );
  }
  if (source.indexOf(anchor, first + anchor.length) !== -1) {
    throw new Error(`Template patch failed (${label}): anchor appears more than once.`);
  }
  return source.slice(0, first) + replacement + source.slice(first + anchor.length);
}

function prepareTemplate() {
  if (!fs.existsSync(TEMPLATE_SRC)) {
    throw new Error(`WebView template not found: ${TEMPLATE_SRC}\nRun: npm install`);
  }
  if (!fs.existsSync(BRIDGE_SNIPPET)) {
    throw new Error(`CSV bridge snippet not found: ${BRIDGE_SNIPPET}`);
  }

  return extractTemplate()
    .then(patchMainActivity)
    .then(zipTemplate)
    .then((zipPath) => {
      // Fail here rather than deep inside the package with a cryptic EISDIR.
      if (!fs.existsSync(zipPath) || !fs.statSync(zipPath).isFile()) {
        throw new Error(`Patched template is not a readable file: ${zipPath}`);
      }
      if (path.extname(zipPath).toLowerCase() !== '.zip') {
        throw new Error(`Template must be a .zip (got ${path.basename(zipPath)}).`);
      }
      const kb = (fs.statSync(zipPath).size / 1024).toFixed(1);
      console.log(`[build-apk] Template zip ready: ${zipPath} (${kb} KB)`);
      return zipPath;
    });
}

async function extractTemplate() {
  // Fresh working copy every build so the patch is deterministic.
  fs.rmSync(TEMPLATE_WORK_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEMPLATE_WORK_DIR, { recursive: true });
  await fs
    .createReadStream(TEMPLATE_SRC)
    .pipe(unzipper.Extract({ path: TEMPLATE_WORK_DIR }))
    .promise();
}

// Repackage the patched working copy as a zip, because the package's
// extractZipSafe() only accepts a file path.
function zipTemplate() {
  return new Promise((resolve, reject) => {
    fs.rmSync(TEMPLATE_ZIP, { force: true });

    const output = fs.createWriteStream(TEMPLATE_ZIP);
    const archive = new ZipArchive({ zlib: { level: 9 } });

    output.on('close', () => resolve(TEMPLATE_ZIP));
    output.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') console.warn('[build-apk] zip warning:', err.message);
      else reject(err);
    });

    archive.pipe(output);
    // Directory entries are not required; the package recreates parents itself.
    archive.directory(TEMPLATE_WORK_DIR, false);
    archive.finalize();
  });
}

// Reads the produced archive back and confirms it is a valid zip containing the
// patched MainActivity, so a bad archive fails here instead of inside the build.
async function verifyTemplateZip(zipPath) {
  const directory = await unzipper.Open.file(zipPath);
  const entry = directory.files.find(
    (f) => f.path.replace(/\\/g, '/') === MAIN_ACTIVITY_REL.replace(/\\/g, '/')
  );
  if (!entry) {
    throw new Error(`Patched zip is missing ${MAIN_ACTIVITY_REL}`);
  }
  const source = (await entry.buffer()).toString('utf8');
  if (source.indexOf('"AndroidCsv"') === -1) {
    throw new Error('Patched zip does not contain the AndroidCsv bridge.');
  }
  console.log(
    `[build-apk] Verified zip: ${directory.files.length} entries, bridge present.`
  );
}

function patchMainActivity() {
  const activityPath = path.join(TEMPLATE_WORK_DIR, MAIN_ACTIVITY_REL);
  if (!fs.existsSync(activityPath)) {
    throw new Error(`MainActivity.java not found in template at ${activityPath}`);
  }

  let src = fs.readFileSync(activityPath, 'utf8');
  const bridge = fs.readFileSync(BRIDGE_SNIPPET, 'utf8').replace(/\r\n/g, '\n');

  // 1. Imports (kept ASCII-only: javac defaults to the platform encoding).
  src = injectOnce(
    src,
    'import android.app.Activity;',
    'import android.app.Activity;\n' + BRIDGE_IMPORTS,
    'imports'
  );

  // 2. Register the bridge right after the WebView is configured.
  src = injectOnce(src, '        initWebView();', '        initWebView();\n        setupCsvBridge();', 'bridge registration');

  // 3. Append the bridge members as the last members of the class.
  const closeAt = src.lastIndexOf('\n}');
  if (closeAt === -1) throw new Error('Template patch failed: could not find the class closing brace.');
  src = src.slice(0, closeAt) + '\n' + bridge + src.slice(closeAt);

  fs.writeFileSync(activityPath, src, 'utf8');

  // Sanity checks before handing the folder to Gradle.
  const patched = fs.readFileSync(activityPath, 'utf8');
  const opens = (patched.match(/\{/g) || []).length;
  const closes = (patched.match(/\}/g) || []).length;
  if (opens !== closes) {
    throw new Error(`Template patch failed: unbalanced braces (${opens} open, ${closes} close).`);
  }
  if (patched.indexOf('"AndroidCsv"') === -1) {
    throw new Error('Template patch failed: JavascriptInterface name missing from patched source.');
  }

  console.log('[build-apk] Patched MainActivity.java with the CSV export bridge.');
  return TEMPLATE_WORK_DIR;
}

async function main() {
  if (!fs.existsSync(path.join(SOURCE_DIR, 'index.html'))) {
    throw new Error('index.html not found next to build-apk.js');
  }

  copyWebsite();

  // hbh-web2app has no default icon: app/builder.js only calls generateIcons()
  // when appIcon is truthy, yet the bundled template's adaptive-icon XML always
  // references @mipmap/ic_launcher_foreground. Building without an icon fails
  // with a confusing "resource mipmap/ic_launcher_foreground not found".
  if (!fs.existsSync(ICON_PATH)) {
    throw new Error(
      `Icon not found: ${ICON_PATH}\n` +
        'hbh-web2app has no default icon and will fail with ' +
        '"resource mipmap/ic_launcher_foreground not found" without one.\n' +
        'Fix: run "node make-icon.js" to generate one, or drop your own 512x512 PNG at that path.'
    );
  }

  console.log(`[build-apk] Building "${APP_NAME}" (${PACKAGE_NAME})...`);
  console.log(`[build-apk] Icon: ${ICON_PATH}`);

  const templatePath = await prepareTemplate();

  // `node build-apk.js --patch-only` stops here so the template patch can be
  // inspected without running a full Gradle build.
  if (process.argv.includes('--patch-only')) {
    await verifyTemplateZip(templatePath);
    console.log('[build-apk] --patch-only: skipping GenerateApp.');
    return;
  }

  await GenerateApp({
    appName: APP_NAME,
    packageName: PACKAGE_NAME,
    asset: WWW_DIR, // folder containing index.html
    appIcon: ICON_PATH,
    template: templatePath // patched .zip; the package only accepts a file path
  });

  const apk = path.join(OUTPUT_DIR, APP_NAME, `${APP_NAME}.apk`);
  if (fs.existsSync(apk)) {
    const sizeMb = (fs.statSync(apk).size / 1024 / 1024).toFixed(1);
    console.log(`[build-apk] Done: ${apk} (${sizeMb} MB)`);
  } else {
    console.log(`[build-apk] Finished, but no APK found at ${apk} — check the output above.`);
  }
}

main().catch((err) => {
  console.error('[build-apk] Build failed:', err && err.message ? err.message : err);
  process.exit(1);
});
