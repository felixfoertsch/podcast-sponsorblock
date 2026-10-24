const { parentPort, workerData } = require('worker_threads')
const { align } = require('./daiAlignment')
const fs = require('fs')
const mpeg = require('./mpegFrameAlignment')
parentPort.postMessage(typeof workerData.original === 'string'
  ? mpeg.align(mpeg.frames(fs.readFileSync(workerData.original)), typeof workerData.variant === 'string' ? mpeg.frames(fs.readFileSync(workerData.variant)) : workerData.variant)
  : align(workerData.original, workerData.variant))
