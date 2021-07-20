import { providers, utils } from "ethers"
import { BlockData, StorageProof } from "./types"
import blockHeaderFromRpc from "@ethereumjs/block/dist/header-from-rpc"
import EthCommon from "@ethereumjs/common"
import { BaseTrie } from "merkle-patricia-tree"
import { Proof } from "merkle-patricia-tree/dist/baseTrie"
import { rlp } from "ethereumjs-util"

export class ERC20Prover {
    provider: providers.JsonRpcProvider | providers.Web3Provider | providers.IpcProvider | providers.InfuraProvider

    constructor(provider: string | providers.JsonRpcProvider | providers.Web3Provider | providers.IpcProvider | providers.InfuraProvider) {
        if (typeof provider == "string") {
            this.provider = new providers.JsonRpcProvider(provider)
            return
        }
        this.provider = provider
    }

    /** Fetches (and optionally verifies) the storage proof of the given keys within the given contract */
    async getProof(contractAddress: string, storageKeys: string[] = [], blockNumber: number | "latest" = "latest", verify?: boolean) {
        const targetBlockNumber = typeof blockNumber == "number" ?
            blockNumber : await this.provider.getBlockNumber()

        const proof = await this.fetchStorageProof(contractAddress, storageKeys, targetBlockNumber)
        const block = await this.fetchBlock(targetBlockNumber)

        if (verify) {
            await this.verify(block.stateRoot, contractAddress, proof)
        }

        const network = await this.provider.getNetwork()
        const blockHeaderRLP = this.getHeaderRLP(block, network.name)
        const accountProofRLP = this.encodeProof(proof.accountProof)
        const storageProofsRLP = proof.storageProof.map(p => this.encodeProof(p.proof))

        return {
            proof,
            block,
            blockHeaderRLP,
            accountProofRLP,
            storageProofsRLP
        }
    }

    /** Computes the slot where the given token holder would have its balance stored, if the balance mapping was assigned the given position */
    public static getHolderBalanceSlot(holderAddress: string, balanceMappingPosition: number): string {
        // Equivalent to keccak256(abi.encodePacked(bytes32(holder), balanceMappingPosition));
        return utils.solidityKeccak256(["bytes32", "uint256"], [utils.hexZeroPad(holderAddress.toLowerCase(), 32), balanceMappingPosition])
    }

    /** Returns true if the given proof conforms to the given stateRoot and contract address */
    public async verify(stateRoot: string, contractAddress: string, proof: StorageProof) {
        // Verify account proof locally
        const isAccountProofValid = await this.verifyAccountProof(stateRoot, contractAddress, proof)
        if (!isAccountProofValid) {
            throw new Error("Local verification of account proof failed")
        }

        // Verify storage proofs locally
        const storageProofs = await Promise.all(proof.storageProof.map(
            storageProof => this.verifyStorageProof(proof.storageHash, storageProof)
        ))

        const failedProofs = storageProofs.filter(result => !result)

        if (failedProofs.length > 0) {
            throw new Error(`Proof failed for storage proofs ${JSON.stringify(failedProofs)}`)
        }
    }

    /** Checks whether the given key has no branch leading to it on the given Trie */
    public static isNonExisting(hexKey: string, proof: StorageProof["storageProof"][0]["proof"]) {
        // https://github.com/ethereumjs/merkle-patricia-tree/blob/master/test/proof.spec.ts#L10-L37
        const proofNodes = proof.map(p => Buffer.from(p.replace("0x", "")))
        return BaseTrie.fromProof(proofNodes)
            .then(trie => {
                const key = Buffer.from(hexKey.replace("0x", ""))
                return trie.get(key)
            })
            .then(node => {
                return node === null
            })
    }

    // PRIVATE

    private verifyAccountProof(stateRoot: string, contractAddress: string, proof: StorageProof): Promise<boolean> {
        const path = utils.keccak256(contractAddress).slice(2)

        return this.verifyProof(stateRoot, path, proof.accountProof)
            .then(proofAccountRLP => {
                if (!proofAccountRLP) throw new Error("Could not verify the account proof")

                const stateAccountRlp = this.encodeAccountRlp(proof)
                return Buffer.compare(stateAccountRlp, proofAccountRLP) === 0
            })
    }

    private verifyStorageProof(storageRoot: string, storageProof: { key: string, proof: string[], value: string }): Promise<boolean> {
        const path = utils.solidityKeccak256(["uint256"], [storageProof.key]).slice(2)

        return this.verifyProof(storageRoot, path, storageProof.proof)
            .then(proofStorageValue => {
                if (!proofStorageValue) throw new Error("Could not verify the storage proof")

                const stateValueRLP = rlp.encode(storageProof.value)
                return Buffer.compare(proofStorageValue, stateValueRLP) === 0
            })
    }

    private verifyProof(rootHash: string, path: string, proof: string[]): Promise<Buffer> {
        // Note: crashing when the account is not used???
        // Error: Key does not match with the proof one (extention|leaf)

        const rootHashBuff = Buffer.from(rootHash.replace("0x", ""), "hex")
        const pathBuff = Buffer.from(path.replace("0x", ""), "hex")
        const proofBuffers: Proof = proof.map(p => Buffer.from(p.replace("0x", ""), "hex"))

        return BaseTrie.verifyProof(rootHashBuff, pathBuff, proofBuffers)
    }

    private encodeProof(proof): string {
        return "0x" + rlp.encode(proof.map(part => rlp.decode(part))).toString("hex")
    }

    private encodeAccountRlp({ nonce, balance, storageHash, codeHash }: { nonce: string, balance: string, storageHash: string, codeHash: string }) {
        if (balance === "0x0") {
            balance = null // account RLP sets a null value if the balance is 0
        }

        return rlp.encode([nonce, balance, storageHash, codeHash])
    }

    private fetchStorageProof(contractAddress: string, storageKeys: any[], blockNumber: number): Promise<StorageProof> {
        const hexBlockNumber = utils.hexValue(blockNumber)

        return this.provider.send("eth_getProof", [contractAddress, storageKeys, hexBlockNumber])
            .then((response: StorageProof) => {
                if (!response) throw new Error("Block not found")
                return response
            })
    }

    private fetchBlock(blockNumber: number): Promise<BlockData> {
        const hexBlockNumber = utils.hexValue(blockNumber)

        return this.provider.send("eth_getBlockByNumber", [hexBlockNumber, false])
            .then((response: BlockData) => {
                if (!response) throw new Error("Block not found")
                return response
            })
    }

    private getHeaderRLP(rpcBlock: BlockData, networkId: string): string {
        const common = getEthHeaderParseOptions(parseInt(rpcBlock.number), networkId)

        const header = blockHeaderFromRpc(rpcBlock, { common })

        const blockHash = "0x" + header.hash().toString("hex")
        if (blockHash !== rpcBlock.hash) {
            throw new Error(`Block header RLP hash (${blockHash}) doesn't match block hash (${rpcBlock.hash})`)
        }

        const blockHeaderRLP = header.serialize().toString("hex")
        return "0x" + blockHeaderRLP
    }
}

// HELPERS

function getEthHeaderParseOptions(blockNumber: number, networkId: string) {
    switch (networkId) {
        case "mainnet":
        case "homestead":
            networkId = "mainnet"
            if (blockNumber < 12965000) return new EthCommon({ chain: networkId })
        case "ropsten":
            if (blockNumber < 10499401) return new EthCommon({ chain: networkId })
        case "goerli":
            if (blockNumber < 5062605) return new EthCommon({ chain: networkId })
        case "rinkeby":
            if (blockNumber < 8897988) return new EthCommon({ chain: networkId })
    }

    return new EthCommon({ chain: networkId, hardfork: "london" })
}
