import { execFileSync } from "node:child_process";

/*
 * Whether this machine will stay awake long enough to run a scan.
 *
 * launchd fires a StartCalendarInterval job during a macOS dark wake (Power
 * Nap, a maintenance wake), which lasts a few seconds before the system sleeps
 * again. A scan started there is frozen for the rest of its time budget: the
 * wall-clock deadline expires while the process is suspended, a browser never
 * finishes launching, and the run is recorded as a timeout with nothing read.
 * The same happens in the few seconds of full wake a notification causes under
 * a closed lid.
 *
 * IOPMrootDomain publishes both signals. "System Capabilities" is a bit mask
 * (CPU 1, graphics 2, audio 4, network 8): a dark wake has no graphics bit.
 * "AppleClamshellState" with "AppleClamshellCausesSleep" says the lid is closed
 * and nothing (an external display) keeps the machine awake.
 */

const GRAPHICS_CAPABILITY = 0x02;
const AWAKE = Object.freeze({ awake: true, reason: null });

function property(text, name) {
  const match = String(text).match(new RegExp(`"${name}"\\s*=\\s*(\\S+)`));
  return match ? match[1] : null;
}

/** Read `ioreg -r -c IOPMrootDomain -d 1` output. Anything unreadable counts as awake. */
export function parsePowerState(text) {
  const capabilities = Number(property(text, "System Capabilities"));
  if (!Number.isInteger(capabilities) || capabilities <= 0) return { ...AWAKE };
  if (!(capabilities & GRAPHICS_CAPABILITY)) {
    return { awake: false, reason: "The Mac is in a dark wake and will sleep again within seconds." };
  }
  if (property(text, "AppleClamshellState") === "Yes" && property(text, "AppleClamshellCausesSleep") === "Yes") {
    return { awake: false, reason: "The lid is closed and the Mac is about to sleep." };
  }
  return { ...AWAKE };
}

function readIoreg() {
  return execFileSync("/usr/sbin/ioreg", ["-r", "-c", "IOPMrootDomain", "-d", "1"], { encoding: "utf8", timeout: 5_000 });
}

/**
 * Only macOS is probed: the dark wake is its behaviour, and cron on Linux does
 * not fire while the machine sleeps. A probe that fails never blocks a run.
 */
export function systemAwakeStatus({ platform = process.platform, readPowerState = readIoreg } = {}) {
  if (platform !== "darwin") return { ...AWAKE };
  try {
    return parsePowerState(readPowerState());
  } catch {
    return { ...AWAKE };
  }
}
