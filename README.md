# 0n3 for your desktop

A chat bubble that sits on top of every window. Ask in plain words; **your own AI on this computer** (Claude Code, Codex,
Gemini CLI or Ollama) does the work through the apps you connected at [0n3.app](https://0n3.app), and asks you before
anything it is unsure about. No API key, no credits.

**Download:** the latest release — `0n3-mac-arm64.dmg` (Apple silicon), `0n3-mac-x64.dmg` (Intel), `0n3-win-x64.exe`.
Not code-signed yet: on a Mac, right-click the app → Open the first time; on Windows, SmartScreen → More info → Run anyway.

What is inside: an Electron shell (bubble + panel + tray) around the 0n3 desk agent from the `0nmcp` package. The panel is
`https://0n3.app/chat`. Sign in once; this computer becomes your desk. Press **⌘⇧Space** (Ctrl+Shift+Space) anywhere.

```
npm install
npm start          # run it here
npm run dist       # build the installers into dist/
```

Source license: BUSL-1.1 (RocketOpp LLC). The desk agent and its protocol are documented at https://0n3.app/developers.
