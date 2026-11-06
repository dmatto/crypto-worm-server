// Without an Apple Developer ID we still ad-hoc sign the Mac app, so macOS offers
// "Open Anyway" instead of calling the download damaged. Real signing + notarization
// replace this once there is an Apple Developer account.
const { execFileSync } = require('child_process');
const path = require('path');
exports.default = async function (ctx) {
  if (ctx.electronPlatformName !== 'darwin') return;
  const appPath = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
};
