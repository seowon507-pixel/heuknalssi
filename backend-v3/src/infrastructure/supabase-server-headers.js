export function createSupabaseServerHeaders(serviceKey) {
  const headers = {
    apikey: serviceKey,
    "Content-Type": "application/json",
  };
  // Supabase's opaque sb_secret_* keys must be sent through apikey only. The
  // legacy service_role value is a JWT and still needs Authorization.
  if (!serviceKey.startsWith("sb_secret_")) {
    headers.Authorization = `Bearer ${serviceKey}`;
  }
  return headers;
}
