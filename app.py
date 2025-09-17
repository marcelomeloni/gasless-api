import os
import base64
from dotenv import load_dotenv
from flask import Flask, request, jsonify
from flask_cors import CORS

# Solana e Anchor
from solders.pubkey import Pubkey
from solders.keypair import Keypair
from solders.system_program import ID as SYS_PROGRAM_ID
from solana.rpc.async_api import AsyncClient
from solana.transaction import Transaction
from anchorpy.program.core import Program
from anchorpy.provider import Provider
from anchorpy.idl import Idl
from anchorpy.error import AnchorError

# Carrega variáveis de ambiente do arquivo .env (essencial para desenvolvimento local)
load_dotenv()

# --- 1. CONFIGURAÇÃO INICIAL ---

# Configuração do Flask
app = Flask(__name__)
CORS(app)  # Permite requisições de origens diferentes (ex: seu frontend)

# Configurações da Solana
RPC_URL = os.getenv("RPC_URL")
if not RPC_URL:
    raise ValueError("A variável de ambiente 'RPC_URL' não foi encontrada.")

# A carteira do backend que pagará as taxas (fee payer).
# A Keypair é derivada da seed phrase de 12 palavras.
seed_phrase = os.getenv("SEED_PHRASSE")
if not seed_phrase:
    raise ValueError("A variável de ambiente 'SEED_PHRASE' não foi encontrada.")

# Deriva a chave privada a partir da seed. Apenas os 32 primeiros bytes são usados.
seed_bytes = seed_phrase.encode('utf-8')
FEE_PAYER_KEYPAIR = Keypair.from_seed(seed_bytes[:32])

# ID do seu programa Anchor (obtido de lib.rs ou declare_id!)
PROGRAM_ID = Pubkey.from_string("VpDhKZvKNsrEkdpiy8MMS3ArTXYV5wrZMTEBxGYE4UL")

# IDs de programas essenciais da Solana, que são constantes
TOKEN_PROGRAM_ID = Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
ASSOCIATED_TOKEN_PROGRAM_ID = Pubkey.from_string("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
TOKEN_METADATA_PROGRAM_ID = Pubkey.from_string("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s")
SYSVAR_RENT_PUBKEY = Pubkey.from_string("SysvarRent111111111111111111111111111111111")

# Constante de seed do programa (deve ser idêntica à do programa Rust)
# Baseado no arquivo mint_ticket.rs, o seed é `BUYER_TICKET_COUNT_SEED`
BUYER_TICKET_COUNT_SEED = b"buyer_ticket_count"


# --- 2. FUNÇÃO ASSÍNCRONA PARA CONFIGURAR O PROGRAMA ANCHOR ---
# Usamos uma função assíncrona para que possamos usar 'await' nas chamadas de rede
async def setup_anchor_program():
    """
    Conecta ao cluster Solana e carrega o programa Anchor usando o IDL.
    Retorna uma instância do programa e o cliente RPC.
    """
    client = AsyncClient(RPC_URL)
    provider = Provider(client, FEE_PAYER_KEYPAIR)
    
    # Carrega o IDL do arquivo JSON. Certifique-se que o caminho está correto.
    with open("idl/ticketing_system.json", "r") as f:
        idl = Idl.from_json(f.read())
        
    program = Program(idl, PROGRAM_ID, provider)
    return program, client


# --- 3. ENDPOINTS DA API ---

@app.route('/create-mint-transaction', methods=['POST'])
async def create_mint_transaction():
    """
    Endpoint para criar a transação de mint.
    O backend prepara a transação, paga as taxas e a assina parcialmente.
    A transação é então enviada ao frontend para a assinatura do usuário.
    """
    try:
        # --- a. Validação da Requisição ---
        data = request.get_json()
        if not data or 'buyer_pubkey' not in data or 'event_pubkey' not in data or 'tier_index' not in data:
            return jsonify({"error": "Parâmetros 'buyer_pubkey', 'event_pubkey' e 'tier_index' são obrigatórios."}), 400

        buyer_pubkey = Pubkey.from_string(data['buyer_pubkey'])
        event_pubkey = Pubkey.from_string(data['event_pubkey'])
        tier_index = int(data['tier_index'])

        # --- b. Configuração do Programa e Cliente ---
        program, client = await setup_anchor_program()

        # --- c. Geração de PDAs e Contas necessárias ---
        # Este passo é crucial e deve espelhar exatamente a lógica de derivação de endereços do programa Rust.

        # 1. global_config: `seeds = [b"config"]`
        global_config_pda, _ = Pubkey.find_program_address([b"config"], PROGRAM_ID)

        # 2. refund_reserve: `seeds = [b"refund_reserve", event.key().as_ref()]`
        refund_reserve_pda, _ = Pubkey.find_program_address([b"refund_reserve", bytes(event_pubkey)], PROGRAM_ID)

        # 3. buyer_ticket_count: `seeds = [BUYER_TICKET_COUNT_SEED, event.key().as_ref(), buyer.key().as_ref()]`
        buyer_ticket_count_pda, _ = Pubkey.find_program_address([BUYER_TICKET_COUNT_SEED, bytes(event_pubkey), bytes(buyer_pubkey)], PROGRAM_ID)
        
        # 4. mint_account: Esta é uma conta nova, então geramos um novo Keypair para ela.
        # O usuário e o backend (como fee payer) precisarão assinar para sua criação.
        new_mint_keypair = Keypair()

        # 5. metadata_account (PDA do Token Metadata Program)
        # `seeds = [b"metadata", metadata_program_id.as_ref(), mint.key().as_ref()]`
        metadata_pda, _ = Pubkey.find_program_address(
            [b"metadata", bytes(TOKEN_METADATA_PROGRAM_ID), bytes(new_mint_keypair.pubkey())],
            TOKEN_METADATA_PROGRAM_ID
        )

        # 6. associated_token_account (ATA)
        # O ATA é derivado do dono (buyer) e do mint.
        ata, _ = Pubkey.find_program_address(
            [bytes(buyer_pubkey), bytes(TOKEN_PROGRAM_ID), bytes(new_mint_keypair.pubkey())],
            ASSOCIATED_TOKEN_PROGRAM_ID
        )

        # 7. ticket: `seeds = [b"ticket", event.key().as_ref(), mint_account.key().as_ref()]`
        ticket_pda, _ = Pubkey.find_program_address([b"ticket", bytes(event_pubkey), bytes(new_mint_keypair.pubkey())], PROGRAM_ID)
        
        # --- d. Construção da Transação ---
        instruction = await program.methods['mint_ticket'](tier_index).accounts({
            "global_config": global_config_pda,
            "event": event_pubkey,
            "refund_reserve": refund_reserve_pda,
            "buyer": buyer_pubkey,
            "buyer_ticket_count": buyer_ticket_count_pda,
            "mint_account": new_mint_keypair.pubkey(),
            "metadata_account": metadata_pda,
            "associated_token_account": ata,
            "token_metadata_program": TOKEN_METADATA_PROGRAM_ID,
            "token_program": TOKEN_PROGRAM_ID,
            "associated_token_program": ASSOCIATED_TOKEN_PROGRAM_ID,
            "system_program": SYS_PROGRAM_ID,
            "rent": SYSVAR_RENT_PUBKEY,
            "ticket": ticket_pda,
        }).instruction()

        latest_blockhash = (await client.get_latest_blockhash()).value.blockhash

        tx = Transaction(
            recent_blockhash=latest_blockhash,
            fee_payer=FEE_PAYER_KEYPAIR.pubkey()
        )
        tx.add(instruction)

        # --- e. Assinatura Parcial pelo Backend ---
        # O backend assina como pagador (fee_payer) e pela criação da nova conta de mint.
        # O 'buyer' (usuário) ainda precisa assinar.
        tx.sign(FEE_PAYER_KEYPAIR, new_mint_keypair)
        
        # --- f. Serialização da Transação ---
        # A transação é serializada para Base64 para ser enviada ao frontend via JSON.
        serialized_tx = tx.serialize(verify_signatures=False) # 'False' pois a assinatura do buyer está faltando
        b64_tx = base64.b64encode(serialized_tx).decode('utf-8')
        
        return jsonify({"transaction": b64_tx})

    except ValueError as e:
        return jsonify({"error": f"Erro de valor ou chave pública inválida: {str(e)}"}), 400
    except AnchorError as e:
        return jsonify({"error": f"Erro do programa Anchor: {e.args}"}), 500
    except Exception as e:
        return jsonify({"error": f"Ocorreu um erro inesperado: {str(e)}"}), 500


@app.route('/finalize-mint-transaction', methods=['POST'])
async def finalize_mint_transaction():
    """
    Endpoint para receber a transação assinada pelo usuário, enviá-la
    para a blockchain e confirmar sua execução.
    """
    try:
        data = request.get_json()
        if not data or 'signed_transaction' not in data:
            return jsonify({"error": "Parâmetro 'signed_transaction' é obrigatório."}), 400
            
        signed_tx_b64 = data['signed_transaction']
        
        # Decodifica a transação de Base64 para bytes
        raw_tx = base64.b64decode(signed_tx_b64)
        
        _, client = await setup_anchor_program()

        # Envia a transação bruta, que agora está completamente assinada.
        tx_signature = await client.send_raw_transaction(raw_tx)
        
        # Aguarda a confirmação da transação pela rede.
        await client.confirm_transaction(tx_signature.value, commitment="confirmed")

        return jsonify({
            "status": "success",
            "transaction_signature": str(tx_signature.value)
        })

    except ValueError as e:
        return jsonify({"error": f"Erro de valor ou transação inválida: {str(e)}"}), 400
    except Exception as e:
        return jsonify({"error": f"Falha ao finalizar a transação: {str(e)}"}), 500

# Rota de health check para verificar se a API está no ar
@app.route('/', methods=['GET'])
def health_check():
    return jsonify({
        "status": "ok",
        "fee_payer_address": str(FEE_PAYER_KEYPAIR.pubkey())
    })

# Ponto de entrada para rodar com Gunicorn no Render ou localmente
if __name__ == '__main__':
    # O Gunicorn (usado no Render) vai rodar o objeto 'app'.
    # Esta parte agora é apenas para testes locais.
    port = int(os.environ.get('PORT', 5001))

    app.run(host='0.0.0.0', port=port)
