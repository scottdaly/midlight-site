#!/usr/bin/env node

import { countStaleMobileDevices, pruneStaleMobileDevices } from '../services/mobileDeviceService.js';

function parseArgs(argv) {
  const args = new Set(argv.slice(2));
  return {
    dryRun: args.has('--dry-run'),
  };
}

function resolveStaleDays() {
  return Math.max(1, Number(process.env.MOBILE_DEVICE_STALE_DAYS || 60) || 60);
}

function main() {
  const { dryRun } = parseArgs(process.argv);
  const staleDays = resolveStaleDays();
  const staleCount = countStaleMobileDevices({ staleDays });

  if (dryRun) {
    console.log(`[mobile-devices] dry-run: ${staleCount} stale registrations older than ${staleDays} day(s)`);
    return;
  }

  const deleted = pruneStaleMobileDevices({ staleDays });
  console.log(`[mobile-devices] pruned ${deleted} stale registrations older than ${staleDays} day(s)`);
}

main();
