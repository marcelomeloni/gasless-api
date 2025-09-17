import os
import base64
import json
from dotenv import load_dotenv
from flask import Flask, request, jsonify
from flask_cors import CORS
from solders.pubkey import Pubkey
from solders.keypair import Keypair
from solders.system_program import ID as SYS_PROGRAM_ID
from solana.rpc.async_api import AsyncClient
from solana.transaction import Transaction
from solana.rpc.commitment import Confirmed

# Carrega variáveis de ambiente
load_dotenv()

app = Flask(__name__)
CORS(app)

# Configurações
RPC_URL = os.getenv("RPC_URL")
SEED_PHRASE = os.getenv("SEED_PHRASE")

if not RPC_URL or not SEED_PHRASE:
    raise ValueError("Variáveis de ambiente RPC_URL e SEED_PHRASE são obrigatórias.")

# Gera o keypair do fee payer
seed_bytes = SEED_PHRASE.encode('utf-8')[:32]
FEE_PAYER_KEYPAIR = Keypair.from_seed(seed_bytes)

# IDs de programas
PROGRAM_ID = Pubkey.from_string("VpDhKZvKNsrEkdpiy8MMS3ArTXYV5wrZMTEBxGYE4UL")
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

# Gera instruções para mint (simplificado - ajuste com sua IDL)
def create_mint_instruction(buyer_pubkey, event_pubkey, tier_index, new_mint_keypair):
    # Calcula todas as PDAs necessárias
    global_config_pda, _ = find_program_address([b"config"], PROGRAM_ID)
    refund_reserve_pda, _ = find_program_address([b"refund_reserve", bytes(event_pubkey)], PROGRAM_ID)
    buyer_ticket_count_pda, _ = find_program_address([b"buyer_ticket_count", bytes(event_pubkey), bytes(buyer_pubkey)], PROGRAM_ID)
    metadata_pda, _ = find_program_address([b"metadata", bytes(TOKEN_METADATA_PROGRAM_ID), bytes(new_mint_keypair.pubkey())], TOKEN_METADATA_PROGRAM_ID)
    ata_pda, _ = find_program_address([bytes(buyer_pubkey), bytes(TOKEN_PROGRAM_ID), bytes(new_mint_keypair.pubkey())], ASSOCIATED_TOKEN_PROGRAM_ID)
    ticket_pda, _ = find_program_address([b"ticket", bytes(event_pubkey), bytes(new_mint_keypair.pubkey())], PROGRAM_ID)

    # Aqui você precisaria construir a instrução manualmente com base na IDL
    # Este é um placeholder - você deve substituir pelos dados reais da sua IDL
    instruction_data = bytes([0])  # Opcode para mint_ticket
    instruction_data += tier_index.to_bytes(1, 'little')

    accounts = [
        str(global_config_pda), str(event_pubkey), str(refund_reserve_pda),
        str(buyer_pubkey), str(buyer_ticket_count_pda), str(new_mint_keypair.pubkey()),
        str(metadata_pda), str(ata_pda), str(TOKEN_METADATA_PROGRAM_ID),
        str(TOKEN_PROGRAM_ID), str(ASSOCIATED_TOKEN_PROGRAM_ID),
        str(SYS_PROGRAM_ID), str(SYSVAR_RENT_PUBKEY), str(ticket_pda)
    ]

    # Retorna uma instrução genérica (ajuste conforme sua IDL)
    return {
        "program_id": str(PROGRAM_ID),
        "accounts": accounts,
        "data": base64.b64encode(instruction_data).decode('utf-8')
    }

@app.route('/create-mint-transaction', methods=['POST'])
async def create_mint_transaction():
    try:
        data = request.get_json()
        buyer_pubkey = Pubkey.from_string(data['buyer_pubkey'])
        event_pubkey = Pubkey.from_string(data['event_pubkey'])
        tier_index = int(data['tier_index'])

        new_mint_keypair = Keypair()
        client = await get_client()

        # Obtém o último blockhash
        latest_blockhash = (await client.get_latest_blockhash()).value.blockhash

        # Cria a transação
        tx = Transaction(recent_blockhash=latest_blockhash, fee_payer=FEE_PAYER_KEYPAIR.pubkey())
        
        # Adiciona instrução de inicialização do mint (se necessário)
        # Adiciona instrução de mint (genérica - ajuste com create_mint_instruction)
        instruction = create_mint_instruction(buyer_pubkey, event_pubkey, tier_index, new_mint_keypair)
        # Nota: Você precisará converter essa instrução em um objeto Instruction real
        # tx.add(instruction)

        # Assina a transação
        tx.sign(FEE_PAYER_KEYPAIR, new_mint_keypair)
        serialized_tx = tx.serialize()
        b64_tx = base64.b64encode(serialized_tx).decode('utf-8')

        return jsonify({"transaction": b64_tx})

    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/finalize-mint-transaction', methods=['POST'])
async def finalize_mint_transaction():
    try:
        data = request.get_json()
        raw_tx = base64.b64decode(data['signed_transaction'])
        client = await get_client()
        tx_signature = await client.send_raw_transaction(raw_tx)
        await client.confirm_transaction(tx_signature.value, commitment=Confirmed)
        return jsonify({"status": "success", "transaction_signature": str(tx_signature.value)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/health', methods=['GET'])
def health_check():
    return jsonify({"status": "ok", "fee_payer": str(FEE_PAYER_KEYPAIR.pubkey())})

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5001))
    app.run(host='0.0.0.0', port=port)
