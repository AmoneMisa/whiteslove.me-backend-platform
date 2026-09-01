function commissionPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function isAgencyLikeListing(listing) {
  return Boolean(
    listing?.byAgency === true ||
    listing?.commission === true ||
    (commissionPercent(listing?.commissionPercent) ?? 0) > 0
  );
}
