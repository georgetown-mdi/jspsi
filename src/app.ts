import express, { Application } from 'express';

import path from 'path';
import { default as cookieParser } from 'cookie-parser';
import { default as logger } from 'morgan';
import qs from 'qs';

import { errorHandler } from './middlewares/errorHandler';

import psiRoutes from './routes/psi';

const app: Application = express();

// view engine setup
app.set('views', path.join(__dirname, '..', 'views'));
app.set('view engine', 'pug');
app.set('query parser', (str: string) => qs.parse(str));

app.set('isDevelopment', process.env.NODE_ENV === 'development');

app.use(errorHandler);
app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/', psiRoutes);

export default app;
