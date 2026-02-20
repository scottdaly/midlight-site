const counters = {
  payloadRejectHttp: 0,
  payloadRejectStream: 0,
  invalidRequestRejectHttp: 0,
  invalidRequestRejectStream: 0,
  attachmentValidationWarn: 0,
  pdfExtractionTruncated: 0,
  pdfExtractionFailed: 0,
};

export function incrementGuardrailMetric(name) {
  if (!(name in counters)) return;
  counters[name] += 1;
}

export function getGuardrailMetrics() {
  return { ...counters };
}

export function resetGuardrailMetrics() {
  for (const key of Object.keys(counters)) {
    counters[key] = 0;
  }
}
