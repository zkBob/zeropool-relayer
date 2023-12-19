// @ts-ignore
import cors from 'cors'
import { Signer, keccak256, getBytes } from 'ethers'
import { toBN } from 'web3-utils'
import express, { NextFunction, Request, Response } from 'express'
import { checkSignMPCSchema, validateBatch } from '../validation/api/validation'
import { logger } from '../services/appLogger'
import { TxDataMPC, validateTxMPC } from '../validation/tx/validateTx'
import { TxData, buildTxData } from '@/txProcessor'
import { numToHex, packSignature } from '@/utils/helpers'
import { VK } from 'libzkbob-rs-node'
import { getTxProofField, parseDelta } from '@/utils/proofInputs'
import { ENERGY_SIZE, TOKEN_SIZE, TRANSFER_INDEX_SIZE } from '@/utils/constants'
import config from '@/configs/guardConfig'
import type { Network, NetworkContract } from '@/services/network'

function wrapErr(f: (_req: Request, _res: Response, _next: NextFunction) => Promise<void> | void) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await f(req, res, next)
    } catch (e) {
      next(e)
    }
  }
}

interface RouterConfig {
  signer: Signer
  poolContract: NetworkContract<Network>
}

export function createRouter({ signer, poolContract }: RouterConfig) {
  const router = express.Router()

  router.use(cors())
  router.use(express.urlencoded({ extended: true }))
  router.use(express.json())
  router.use(express.text())

  router.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    if (err) {
      logger.error('Request error:', err)
      return res.sendStatus(500)
    }
    next()
  })

  router.post(
    '/sign',
    wrapErr(async (req: Request, res: Response) => {
      validateBatch([[checkSignMPCSchema, req.body]])
      const message = req.body as TxDataMPC

      // Validate
      const txVK: VK = require(config.GUARD_TX_VK_PATH)
      const treeVK: VK = require(config.GUARD_TREE_VK_PATH)

      const poolId = toBN(await poolContract.call('pool_id'))

      try {
        await validateTxMPC(message, poolId, treeVK, txVK)
      } catch (e) {
        console.log('Validation error', e)
        throw new Error('Invalid transaction')
      }

      // Sign
      const { txProof, treeProof } = message
      const nullifier = getTxProofField(txProof, 'nullifier')
      const outCommit = getTxProofField(txProof, 'out_commit')
      const delta = parseDelta(getTxProofField(txProof, 'delta'))

      const rootAfter = treeProof.inputs[1]

      const txData: TxData = {
        txProof: message.txProof.proof,
        treeProof: message.treeProof.proof,
        nullifier: numToHex(toBN(nullifier)),
        outCommit: numToHex(toBN(outCommit)),
        rootAfter: numToHex(toBN(rootAfter)),
        delta: {
          transferIndex: numToHex(delta.transferIndex, TRANSFER_INDEX_SIZE),
          energyAmount: numToHex(delta.energyAmount, ENERGY_SIZE),
          tokenAmount: numToHex(delta.tokenAmount, TOKEN_SIZE),
        },
        txType: message.txType,
        memo: message.memo,
        depositSignature: message.depositSignature,
      }

      const transferRoot = numToHex(toBN(getTxProofField(txProof, 'root')))
      const currentRoot = numToHex(toBN(treeProof.inputs[0]))

      let calldata = buildTxData(txData)
      calldata += transferRoot + currentRoot + numToHex(poolId)

      const digest = getBytes(keccak256(calldata))
      const signature = packSignature(await signer.signMessage(digest))

      console.log('Signed', signature)
      res.json({ signature })
    })
  )

  return router
}
