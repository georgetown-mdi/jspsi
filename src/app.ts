import express, { Application } from 'express';

import path from 'path';
import { default as cookieParser } from 'cookie-parser';
import { default as logger } from 'morgan';
import qs from 'qs';
import { default as rateLimit } from 'express-rate-limit';

import { errorHandler } from './middlewares/errorHandler';

import psiRoutes from './routes/psi';

const app: Application = express();

// view engine setup
app.set('views', path.join(__dirname, '..', 'views'));
app.set('view engine', 'pug');
app.set('query parser', (str: string) => qs.parse(str));

app.set('isDevelopment', process.env.NODE_ENV === 'development');

app.use(
  rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes in milliseconds
    max: 100, // Limit each IP to 100 requests per window (5 minutes)
    message: 'Too many requests from this IP, please try again after 5 minutes'
  })
);
app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/', psiRoutes);

app.use(errorHandler);

export default app;
