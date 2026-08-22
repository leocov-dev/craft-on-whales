'use strict';

import type { Request, Response } from 'express';

const express = require('express');
const { getTask, listTasks } = require('../../services/tasks') as typeof import('../../services/tasks');

const router = express.Router();

router.get('/', (req: Request, res: Response) => {
  res.json({ ok: true, tasks: listTasks() });
});

router.get('/:id', (req: Request, res: Response) => {
  const task = getTask(req.params.id as string);
  if (!task) return res.status(404).json({ ok: false, error: 'Unknown or expired task' });
  res.json({ ok: true, task });
});

export { router };
