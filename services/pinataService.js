import axios from 'axios';
import FormData from 'form-data';
import { PINATA_JWT } from '../config/index.js';

export const uploadToPinata = async (file) => {
    try {
        const formData = new FormData();
        formData.append('file', file.buffer, {
            filename: file.originalname,
            contentType: file.mimetype,
        });
        
        const response = await axios.post(
            "https://api.pinata.cloud/pinning/pinFileToIPFS", 
            formData, 
            {
                headers: { 
                    'Authorization': `Bearer ${PINATA_JWT}`,
                    ...formData.getHeaders()
                },
                timeout: 30000
            }
        );
        
        return `https://gateway.pinata.cloud/ipfs/${response.data.IpfsHash}`;
    } catch (uploadError) {
        console.error('Erro no upload para Pinata:', uploadError);
        throw new Error(`Falha no upload da imagem: ${uploadError.message}`);
    }
};

export const uploadJSONToPinata = async (jsonData) => {
    try {
        const response = await axios.post(
            "https://api.pinata.cloud/pinning/pinJSONToIPFS", 
            jsonData, 
            {
                headers: { 
                    'Authorization': `Bearer ${PINATA_JWT}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            }
        );
        return `https://gateway.pinata.cloud/ipfs/${response.data.IpfsHash}`;
    } catch (error) {
        console.error('Erro no upload de JSON para Pinata:', error);
        throw new Error(`Falha no upload dos metadados: ${error.message}`);
    }
};
