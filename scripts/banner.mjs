#!/usr/bin/env node

export function printAgentCompanionBanner() {
  const useColor = shouldUseColor();
  const reset = useColor ? "\x1b[0m" : "";
  const accent = colorRgb(207, 136, 89, useColor, true);
  const dot = colorRgb(105, 191, 166, useColor, true);
  const muted = colorRgb(121, 123, 130, useColor, true);
  const dim = colorRgb(121, 123, 130, useColor);

  console.log("");
  console.log(`  ${accent}▄▀▄${reset} ${dot}·${reset} ${muted}█▀▀${reset}`);
  console.log(`  ${accent}█▀█${reset}   ${muted}█${reset}    ${dim}agent${reset}${dot}.${reset}${dim}companion${reset}`);
  console.log(`  ${accent}▀ ▀${reset}   ${muted}▀▀▀${reset}`);
  console.log("");
}

export function printInfoLine(label, value) {
  const useColor = shouldUseColor();
  const labelColor = colorRgb(121, 123, 130, useColor);
  const valueColor = colorRgb(236, 236, 239, useColor, true);
  const reset = useColor ? "\x1b[0m" : "";

  console.log(`  ${labelColor}${label.padEnd(10)}${reset}${valueColor}${value}${reset}`);
}

function shouldUseColor() {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR === "0") return false;
  return process.stdout.isTTY;
}

function colorRgb(r, g, b, enabled, bold = false) {
  if (!enabled) return "";
  const boldPart = bold ? "1;" : "";
  return `\x1b[${boldPart}38;2;${r};${g};${b}m`;
}
