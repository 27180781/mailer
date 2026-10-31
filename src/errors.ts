export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
  }
}

export const notFound = (what = 'הפריט') => new ApiError(404, 'not_found', `${what} לא נמצא`);
export const forbidden = (msg = 'אין הרשאה לפעולה הזו') => new ApiError(403, 'forbidden', msg);
