// authClient.js
// Supabase Auth(이메일+비밀번호, 가입 시 1회 이메일 인증코드) 연동.
// supabase-js 없이 GoTrue REST API를 직접 호출합니다.
//
// 흐름:
//   1) 회원가입: signUp(email, password) → 이메일로 인증코드 발송
//   2) 가입 확인(최초 1회): confirmSignUp(email, code) → 세션 발급, 로그인 완료
//   3) 이후 로그인: signInWithPassword(email, password) → 코드 없이 바로 세션 발급
// 모든 요청 이후에는 Authorization: Bearer <access_token> 헤더로 로그인 상태를 증명합니다.

export class AuthError extends Error {
  constructor(message, { status = 400, code = 'AUTH_ERROR' } = {}) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
  }
}

export class AuthClient {
  constructor({
    supabaseUrl = process.env.SUPABASE_URL,
    apiKey = process.env.SUPABASE_ANON_KEY,
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (!supabaseUrl || !apiKey) {
      throw new AuthError('Supabase 인증 설정(SUPABASE_URL/SUPABASE_ANON_KEY)이 없습니다.', {
        status: 500,
        code: 'AUTH_NOT_CONFIGURED',
      });
    }
    this.baseUrl = supabaseUrl.replace(/\/$/u, '');
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  /** 회원가입. 이메일 확인이 필요하면 세션 없이 needsConfirmation:true를 돌려줍니다
   *  (프로젝트 설정에 따라 확인 없이 바로 세션이 발급될 수도 있습니다).
   *  redirectTo를 주면, 확인 메일의 링크를 눌렀을 때 그 주소로 돌아오면서 바로
   *  로그인됩니다 (Supabase 프로젝트의 Redirect URL 허용목록에 등록돼 있어야 합니다). */
  async signUp(email, password, redirectTo) {
    const url = new URL(`${this.baseUrl}/auth/v1/signup`);
    if (redirectTo) url.searchParams.set('redirect_to', redirectTo);
    const res = await this.fetchImpl(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: this.apiKey },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw await toAuthError(res, '회원가입에 실패했습니다.');
    const body = await res.json();
    if (body?.access_token && body?.user?.id) {
      return { needsConfirmation: false, ...toSession(body) };
    }
    return { needsConfirmation: true };
  }

  /** 확인 메일을 다시 보냅니다 (가입 시 자동 발송된 메일을 못 받았을 때). */
  async resendSignupConfirmation(email, redirectTo) {
    const url = new URL(`${this.baseUrl}/auth/v1/resend`);
    if (redirectTo) url.searchParams.set('redirect_to', redirectTo);
    const res = await this.fetchImpl(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: this.apiKey },
      body: JSON.stringify({ email, type: 'signup' }),
    });
    if (!res.ok) throw await toAuthError(res, '확인 메일을 다시 보내지 못했습니다.');
  }

  /** 회원가입 시 받은 이메일 인증코드를 직접 입력해 확인하는 대안 경로(수동 입력).
   *  기본 화면은 이메일 링크 클릭으로 로그인하지만, 필요하면 이 메서드로도 확인할 수 있습니다. */
  async confirmSignUp(email, code) {
    const res = await this.fetchImpl(`${this.baseUrl}/auth/v1/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: this.apiKey },
      body: JSON.stringify({ email, token: code, type: 'signup' }),
    });
    if (!res.ok) throw await toAuthError(res, '인증코드가 올바르지 않습니다.');
    const body = await res.json();
    if (!body?.access_token || !body?.user?.id) {
      throw new AuthError('로그인 응답이 올바르지 않습니다.', { status: 502, code: 'AUTH_BAD_RESPONSE' });
    }
    return toSession(body, email);
  }

  /** 가입을 마친 계정의 통상적인 로그인. 코드가 필요 없습니다. */
  async signInWithPassword(email, password) {
    const res = await this.fetchImpl(`${this.baseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: this.apiKey },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw await toAuthError(res, '이메일 또는 비밀번호가 올바르지 않습니다.');
    const body = await res.json();
    if (!body?.access_token || !body?.user?.id) {
      throw new AuthError('로그인 응답이 올바르지 않습니다.', { status: 502, code: 'AUTH_BAD_RESPONSE' });
    }
    return toSession(body, email);
  }

  /** accessToken이 유효하면 { userId, email }을, 아니면 null을 돌려줍니다. */
  async getUser(accessToken) {
    if (!accessToken) return null;
    const res = await this.fetchImpl(`${this.baseUrl}/auth/v1/user`, {
      headers: { apikey: this.apiKey, Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body?.id) return null;
    return { userId: body.id, email: body.email ?? null };
  }

  async signOut(accessToken) {
    if (!accessToken) return;
    await this.fetchImpl(`${this.baseUrl}/auth/v1/logout`, {
      method: 'POST',
      headers: { apikey: this.apiKey, Authorization: `Bearer ${accessToken}` },
    }).catch(() => {}); // 로그아웃 실패해도 클라이언트 쪽 토큰은 어차피 지움
  }
}

function toSession(body, fallbackEmail) {
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    userId: body.user.id,
    email: body.user.email ?? fallbackEmail,
  };
}

// Supabase(GoTrue)가 돌려주는 error_code별 한국어 메시지.
// 모르는 코드는 각 호출부에서 넘긴 한국어 fallbackMessage를 그대로 쓴다 —
// Supabase의 영어 원문(msg/error_description)은 절대 사용자에게 보여주지 않는다.
const AUTH_ERROR_MESSAGES = {
  email_address_invalid: '올바른 이메일 형식이 아니에요.',
  validation_failed: '입력값을 다시 확인해 주세요.',
  user_already_exists: '이미 가입된 이메일이에요.',
  email_exists: '이미 가입된 이메일이에요.',
  weak_password: '비밀번호가 너무 약해요. 다른 비밀번호로 시도해 주세요.',
  same_password: '이전과 같은 비밀번호는 사용할 수 없어요.',
  invalid_credentials: '이메일 또는 비밀번호가 올바르지 않아요.',
  email_not_confirmed: '이메일 인증이 아직 완료되지 않았어요.',
  otp_expired: '인증코드가 만료됐어요. 다시 요청해 주세요.',
  otp_disabled: '인증코드 기능을 사용할 수 없어요.',
  signup_disabled: '지금은 회원가입을 받고 있지 않아요.',
  over_email_send_rate_limit: '이메일 요청이 너무 많아요. 잠시 후 다시 시도해 주세요.',
  over_request_rate_limit: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.',
};

async function toAuthError(res, fallbackMessage) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    // 본문이 JSON이 아니면 무시
  }
  const code = body?.error_code || body?.code || 'AUTH_ERROR';
  const message = AUTH_ERROR_MESSAGES[code] || fallbackMessage;
  return new AuthError(message, { status: res.status, code });
}
