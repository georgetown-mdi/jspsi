var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');

const qs = require('qs')

var psiRouter = require('./routes/psi');

var app = module.exports = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');
app.set('query parser', (str) => qs.parse(str))

app.set('isDevelopment', process.env.NODE_ENV === 'development');

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', psiRouter);