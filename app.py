import os
import base64
import json
from dotenv import load_dotenv
from flask import Flask, request, jsonify
from flask_cors import CORS
from solders.pubkey import Pubkey
from solders.keypair import Keypair
from solders.system_program import ID as SYS_PROGRAM_ID
from solders.instruction import Instruction
from solana.rpc.async_api import AsyncClient
from solana.transaction import Transaction
from solana.rpc.commitment import Confirmed
from anchorpy.program.core import Program
from anchorpy.provider import Provider
from anchorpy.idl import Idl
import asyncio

# Carrega variáveis de ambiente
load_dotenv()

app = Flask(__name__)
CORS(app)

# Configurações
RPC_URL = os.getenv("RPC_URL")
SEED_PHRASE = os.getenv("SEED_PHRASE")

if not RPC_URL or not SEED_PHRASE:
    raise ValueError("Variáveis de ambiente RPC_URL e SEED_PHRASE são obrigatórias.")

# Gera o keypair do fee payer - CORREÇÃO IMPORTANTE
seed_bytes = SEED_PHRASE.encode('utf-8')
if len(seed_bytes) < 32:
    # Padding se a seed for muito curta
    seed_bytes = seed_bytes.ljust(32, b'\0')
elif len(seed_bytes) > 32:
    # Truncar se for muito longa
    seed_bytes = seed_bytes[:32]

FEE_PAYER_KEYPAIR = Keypair.from_seed(seed_bytes)

# IDs de programas - DEVE SER O MESMO DO FRONTEND
PROGRAM_ID = Pubkey.from_string("AEcgrC2sEtWX12zs1m7RemTdcr9QwBkMbJUXfC4oEd2M")  # CORRIGIDO
TOKEN_PROGRAM_ID = Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
ASSOCIATED_TOKEN_PROGRAM_ID = Pubkey.from_string("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
TOKEN_METADATA_PROGRAM_ID = Pubkey.from_string("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s")
SYSVAR_RENT_PUBKEY = Pubkey.from_string("SysvarRent111111111111111111111111111111111")

# Função para calcular PDAs
def find_program_address(seeds, program_id):
    return Pubkey.find_program_address(seeds, program_id)

# Cliente Solana
async def get_client():
    return AsyncClient(RPC_URL)

# Configuração do programa Anchor
async def setup_anchor_program():
    client = AsyncClient(RPC_URL)
    provider = Provider(client, FEE_PAYER_KEYPAIR)
    
    # Carrega o IDL do arquivo
    with open("idl/ticketing_system.json", "r") as f:
        idl_json = json.load(f)
    
    idl = Idl.from_json(idl_json)
    program = Program(idl, PROGRAM_ID, provider)
    return program, client

@app.route('/create-mint-transaction', methods=['POST'])
async def create_mint_transaction():
    try:
        data = request.get_json()
        if not data or 'buyer_pubkey' not in data or 'event_pubkey' not in data or 'tier_index' not in data:
            return jsonify({"error": "Parâmetros 'buyer_pubkey', 'event_pubkey' e 'tier_index' são obrigatórios."}), 400

        buyer_pubkey = Pubkey.from_string(data['buyer_pubkey'])
        event_pubkey = Pubkey.from_string(data['event_pubkey'])
        tier_index = int(data['tier_index'])

        # Configura o programa Anchor
        program, client = await setup_anchor_program()
        
        # Gera um novo keypair para o mint
        new_mint_keypair = Keypair()
        
        # Calcula todas as PDAs necessárias
        global_config_pda, _ = find_program_address([b"config"], PROGRAM_ID)
        refund_reserve_pda, _ = find_program_address([b"refund_reserve", bytes(event_pubkey)], PROGRAM_ID)
        buyer_ticket_count_pda, _ = find_program_address(
            [b"buyer_ticket_count", bytes(event_pubkey), bytes(buyer_pubkey)], 
            PROGRAM_ID
        )
        metadata_pda, _ = find_program_address(
            [b"metadata", bytes(TOKEN_METADATA_PROGRAM_ID), bytes(new_mint_keypair.pubkey())], 
            TOKEN_METADATA_PROGRAM_ID
        )
        
        # Calcula a Associated Token Account
        from solders.instruction import AccountMeta
        accounts = [
            AccountMeta(global_config_pda, is_signer=False, is_writable=True),
            AccountMeta(event_pubkey, is_signer=False, is_writable=True),
            AccountMeta(refund_reserve_pda, is_signer=False, is_writable=True),
            AccountMeta(buyer_pubkey, is_signer=False, is_writable=True),
            AccountMeta(buyer_ticket_count_pda, is_signer=False, is_writable=True),
            AccountMeta(new_mint_keypair.pubkey(), is_signer=False, is_writable=True),
            AccountMeta(metadata_pda, is_signer=False, is_writable=True),
            AccountMeta(TOKEN_METADATA_PROGRAM_ID, is_signer=False, is_writable=False),
            AccountMeta(TOKEN_PROGRAM_ID, is_signer=False, is_writable=False),
            AccountMeta(ASSOCIATED_TOKEN_PROGRAM_ID, is_signer=False, is_writable=False),
            AccountMeta(SYS_PROGRAM_ID, is_signer=False, is_writable=False),
            AccountMeta(SYSVAR_RENT_PUBKEY, is_signer=False, is_writable=False),
        ]

        # Cria a instrução
        instruction = Instruction(
            program_id=PROGRAM_ID,
            data=bytes([0]) + tier_index.to_bytes(1, 'little'),
            accounts=accounts
        )

        # Obtém o último blockhash
        latest_blockhash = (await client.get_latest_blockhash()).value.blockhash

        # Cria a transação
        tx = Transaction(
            recent_blockhash=latest_blockhash,
            fee_payer=FEE_PAYER_KEYPAIR.pubkey(),
            instructions=[instruction]
        )
        
        # Assina a transação com o fee payer e o novo mint
        tx.sign(FEE_PAYER_KEYPAIR, new_mint_keypair)
        
        # Serializa a transação
        serialized_tx = tx.serialize()
        b64_tx = base64.b64encode(serialized_tx).decode('utf-8')

        return jsonify({
            "transaction": b64_tx,
            "mint_public_key": str(new_mint_keypair.pubkey())
        })

    except Exception as e:
        print(f"Erro em /create-mint-transaction: {str(e)}")
        return jsonify({"error": f"Erro interno do servidor: {str(e)}"}), 500

@app.route('/finalize-mint-transaction', methods=['POST'])
async def finalize_mint_transaction():
    try:
        data = request.get_json()
        if not data or 'signed_transaction' not in data:
            return jsonify({"error": "Parâmetro 'signed_transaction' é obrigatório."}), 400
        
        raw_tx = base64.b64decode(data['signed_transaction'])
        _, client = await setup_anchor_program()
        
        tx_signature = await client.send_raw_transaction(raw_tx)
        await client.confirm_transaction(tx_signature.value, commitment=Confirmed)

        return jsonify({
            "status": "success", 
            "transaction_signature": str(tx_signature.value)
        })
    except Exception as e:
        print(f"Erro em /finalize-mint-transaction: {str(e)}")
        return jsonify({"error": f"Falha ao finalizar a transação: {str(e)}"}), 500

@app.route('/health', methods=['GET'])
def health_check():
    return jsonify({
        "status": "ok", 
        "fee_payer_address": str(FEE_PAYER_KEYPAIR.pubkey())
    })

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5001))
    app.run(host='0.0.0.0', port=port)
