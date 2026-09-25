// Opens Terminal.app in a project and starts an agent CLI there. The project path is data, never shell source: it is passed to
// osascript as an argument (argv), and AppleScript's `quoted form of` makes it a single shell word for `cd`.
export function terminalLaunch(projectPath, tool) {
  const cli = tool === 'codex' ? 'codex' : 'claude';
  const script = ['on run argv', 'tell application "Terminal"', 'activate', `do script "cd " & quoted form of (item 1 of argv) & " && ${cli}"`, 'end tell', 'end run'];
  return { cmd: 'osascript', args: [...script.flatMap((line) => ['-e', line]), projectPath] };
}
