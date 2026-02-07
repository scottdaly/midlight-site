import express from 'express';
import errorsRouter from './errors.js';
import usageRouter from './usage.js';
import usersRouter from './users.js';
import subscriptionsRouter from './subscriptions.js';
import searchRouter from './search.js';
import systemRouter from './system.js';

const router = express.Router();

router.use('/', errorsRouter);
router.use('/usage', usageRouter);
router.use('/users', usersRouter);
router.use('/subscriptions', subscriptionsRouter);
router.use('/search', searchRouter);
router.use('/system', systemRouter);

export default router;
