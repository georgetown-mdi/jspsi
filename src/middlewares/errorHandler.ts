import { Request, Response, NextFunction } from 'express';

export interface AppError extends Error {
  status?: number;
}

export const errorHandler = function (
  err: AppError,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('isDevelopment') ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
};
