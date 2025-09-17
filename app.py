import os
import base64
from dotenv import load_dotenv
from flask import Flask, request, jsonify
from flask_cors import CORS

# --- Solana e Anchor ---
# Importações diretas para evitar o bug do anchorpy.__init__
from solders.pubkey import Pubkey
from solders.keypair import Keypair
from solders.system_program import ID as SYS_PROGRAM_ID
from solana.rpc.async_api import AsyncClient
from solana.transaction import Transaction
# Importe Program diretamente do módulo core
from anchorpy.program.core import Program
from anchorpy.provider import Provider
from anchorpy.idl import Idl
from anchorpy.error import AnchorError
# Carrega variáveis de ambiente
load_dotenv()

app = Flask(__name__)
CORS(app)

# --- Variáveis de Ambiente ---
RPC_URL = os.getenv("RPC_URL")
if not RPC_URL:
    raise ValueError("A variável de ambiente 'RPC_URL' é obrigatória.")

SEED_PHRASE = os.getenv("SEED_PHRASE")
if not SEED_PHRASE:
    raise ValueError("A variável de ambiente 'SEED_PHRASE' é obrigatória.")

# --- Chaves e Endereços ---
seed_bytes = SEED_PHRASE.encode('utf-8')
FEE_PAYER_KEYPAIR = Keypair.from_seed(seed_bytes[:32])
PROGRAM_ID = Pubkey.from_string("VpDhKZvKNsrEkdpiy8MMS3ArTXYV5wrZMTEBxGYE4UL")
TOKEN_PROGRAM_ID = Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
ASSOCIATED_TOKEN_PROGRAM_ID = Pubkey.from_string("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
TOKEN_METADATA_PROGRAM_ID = Pubkey.from_string("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s")
SYSVAR_RENT_PUBKEY = Pubkey.from_string("SysvarRent111111111111111111111111111111111")
BUYER_TICKET_COUNT_SEED = b"buyer_ticket_count"

async def setup_anchor_program():
    """Conecta ao cluster Solana e carrega o programa Anchor usando o IDL."""
    client = AsyncClient(RPC_URL)
    provider = Provider(client, FEE_PAYER_KEYPAIR)
    with open("idl/ticketing_system.json", "r") as f:
        idl = Idl.from_json(f.read())
    program = Program(idl, PROGRAM_ID, provider)
    return program, client

@app.route('/create-mint-transaction', methods=['POST'])
async def create_mint_transaction():
    try:
        data = request.get_json()
        if not all(k in data for k in ['buyer_pubkey', 'event_pubkey', 'tier_index']):
            return jsonify({"error": "Parâmetros 'buyer_pubkey', 'event_pubkey' e 'tier_index' são obrigatórios."}), 400

        buyer_pubkey = Pubkey.from_string(data['buyer_pubkey'])
        event_pubkey = Pubkey.from_string(data['event_pubkey'])
        tier_index = int(data['tier_index'])

        program, client = await setup_anchor_program()

        new_mint_keypair = Keypair()
        global_config_pda, _ = Pubkey.find_program_address([b"config"], PROGRAM_ID)
        refund_reserve_pda, _ = Pubkey.find_program_address([b"refund_reserve", bytes(event_pubkey)], PROGRAM_ID)
        buyer_ticket_count_pda, _ = Pubkey.find_program_address([BUYER_TICKET_COUNT_SEED, bytes(event_pubkey), bytes(buyer_pubkey)], PROGRAM_ID)
        metadata_pda, _ = Pubkey.find_program_address([b"metadata", bytes(TOKEN_METADATA_PROGRAM_ID), bytes(new_mint_keypair.pubkey())], TOKEN_METADATA_PROGRAM_ID)
        ata_pda, _ = Pubkey.find_program_address([bytes(buyer_pubkey), bytes(TOKEN_PROGRAM_ID), bytes(new_mint_keypair.pubkey())], ASSOCIATED_TOKEN_PROGRAM_ID)
        ticket_pda, _ = Pubkey.find_program_address([b"ticket", bytes(event_pubkey), bytes(new_mint_keypair.pubkey())], PROGRAM_ID)
        
        instruction = await program.methods['mint_ticket'](tier_index).accounts({
            "global_config": global_config_pda, "event": event_pubkey, "refund_reserve": refund_reserve_pda,
            "buyer": buyer_pubkey, "buyer_ticket_count": buyer_ticket_count_pda, "mint_account": new_mint_keypair.pubkey(),
            "metadata_account": metadata_pda, "associated_token_account": ata_pda, "token_metadata_program": TOKEN_METADATA_PROGRAM_ID,
            "token_program": TOKEN_PROGRAM_ID, "associated_token_program": ASSOCIATED_TOKEN_PROGRAM_ID,
            "system_program": SYS_PROGRAM_ID, "rent": SYSVAR_RENT_PUBKEY, "ticket": ticket_pda,
        }).instruction()

        latest_blockhash = (await client.get_latest_blockhash()).value.blockhash
        tx = Transaction(recent_blockhash=latest_blockhash, fee_payer=FEE_PAYER_KEYPAIR.pubkey())
        tx.add(instruction)
        tx.sign(FEE_PAYER_KEYPAIR, new_mint_keypair)
        
        serialized_tx = tx.serialize(verify_signatures=False)
        b64_tx = base64.b64encode(serialized_tx).decode('utf-8')
        
        return jsonify({"transaction": b64_tx})

    except Exception as e:
        print(f"ERRO em /create-mint-transaction: {e}")
        return jsonify({"error": f"Ocorreu um erro inesperado no backend: {str(e)}"}), 500

@app.route('/finalize-mint-transaction', methods=['POST'])
async def finalize_mint_transaction():
    try:
        data = request.get_json()
        if 'signed_transaction' not in data:
            return jsonify({"error": "Parâmetro 'signed_transaction' é obrigatório."}), 400
        
        raw_tx = base64.b64decode(data['signed_transaction'])
        _, client = await setup_anchor_program()
        tx_signature = await client.send_raw_transaction(raw_tx)
        
        await client.confirm_transaction(tx_signature.value, commitment="confirmed")

        return jsonify({"status": "success", "transaction_signature": str(tx_signature.value)})
    except Exception as e:
        print(f"ERRO em /finalize-mint-transaction: {e}")
        return jsonify({"error": f"Falha ao finalizar a transação: {str(e)}"}), 500

@app.route('/', methods=['GET'])
def health_check():
    return jsonify({
        "status": "ok",
        "fee_payer_address": str(FEE_PAYER_KEYPAIR.pubkey())
    })

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5001))
    app.run(host='0.0.0.0', port=port)

