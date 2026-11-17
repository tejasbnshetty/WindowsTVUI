# WindowsTVUI
Fullscreen media launcher on a Windows laptop, shown on a TV over HDMI.
Controlled from an iPhone web page over local Wi-Fi.
Stack: Electron + TypeScript, ws, koffi (SendInput). No Rust/C++ toolchain.
Rules: work one milestone at a time; commit after each; keep dependencies minimal;
explain how to run and test after every change; never add auth bypasses.
NEVER run tests that send real mouse/keyboard input to the live desktop. Use mocks only;
if real injection is truly needed, ask me and wait.
Milestones: M1 launcher, M2 server+remote, M3 trackpad/keyboard, M4 home+PIN, M5 autostart.