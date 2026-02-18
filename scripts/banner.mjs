#!/usr/bin/env node

export function printAgentCompanionBanner() {
  const useColor = shouldUseColor();
  const reset = useColor ? "\x1b[0m" : "";
  const accent = colorRgb(210, 145, 99, useColor, true);
  const dot = colorRgb(45, 197, 155, useColor, true);
  const muted = colorRgb(148, 154, 167, useColor, true);

  const barLen = 31;
  let bar = "";
  for (let i = 0; i < barLen; i++) {
    const t = i / (barLen - 1);
    let r, g, b;
    if (t < 0.5) {
      const s = t * 2;
      r = lerp(210, 45, s);
      g = lerp(145, 197, s);
      b = lerp(99, 155, s);
    } else {
      const s = (t - 0.5) * 2;
      r = lerp(45, 148, s);
      g = lerp(197, 154, s);
      b = lerp(155, 167, s);
    }
    bar += `${colorRgb(r, g, b, useColor)}━${reset}`;
  }

  console.log("");
  console.log(`  ${accent}a g e n t${reset}  ${dot}·${reset}  ${muted}c o m p a n i o n${reset}`);
  console.log(`  ${bar}`);
  console.log("");
}

export function printInfoLine(label, value) {
  const useColor = shouldUseColor();
  const labelColor = colorRgb(120, 128, 143, useColor);
  const valueColor = colorRgb(210, 215, 224, useColor, true);
  const reset = useColor ? "\x1b[0m" : "";

  console.log(`  ${labelColor}${label.padEnd(10)}${reset}${valueColor}${value}${reset}`);
}

function shouldUseColor() {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR === "0") return false;
  return process.stdout.isTTY;
}

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function colorRgb(r, g, b, enabled, bold = false) {
  if (!enabled) return "";
  const boldPart = bold ? "1;" : "";
  return `\x1b[${boldPart}38;2;${r};${g};${b}m`;
}
