// Launches Electron with ELECTRON_RUN_AS_NODE removed (VS Code terminals set it,
// which makes Electron behave as plain Node and crash).
const { spawn } = require("child_process");
const electron = require("electron");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ["."], { stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 0));
