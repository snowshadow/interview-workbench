import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildInterviewIcs,
  calendarExportFilename,
} from "../../src/lib/calendar.js";

const execFileAsync = promisify(execFile);

export function isLoopbackRequest(request) {
  const address = String(request?.socket?.remoteAddress || "");
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
}

export async function openInterviewInSystemCalendar({
  interview,
  exportDir,
  launch = launchCalendarFile,
  platform = process.platform,
}) {
  if (platform !== "darwin") {
    throw Object.assign(new Error("当前系统不支持直接打开系统日历"), {
      code: "CALENDAR_OPEN_UNSUPPORTED",
    });
  }

  const content = buildInterviewIcs(interview);
  const filename = calendarExportFilename(interview);
  await fs.mkdir(exportDir, { recursive: true, mode: 0o700 });
  const filePath = path.join(exportDir, filename);
  await fs.writeFile(filePath, content, { encoding: "utf8", mode: 0o600 });
  await launch(filePath);
  return { filePath, filename };
}

async function launchCalendarFile(filePath) {
  await execFileAsync("/usr/bin/open", [filePath], { timeout: 5000 });
}
