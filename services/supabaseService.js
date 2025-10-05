import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from '../config/index.js';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

console.log(`[+] Supabase client initialized.`);

export const upsertUserInSupabase = async (userData) => {
    const { name, phone, email, company, sector, role, wallet_address } = userData;
    console.log(` -> Upserting user profile in Supabase for wallet: ${wallet_address}`);

    const { data, error } = await supabase
        .from('profiles')
        .upsert({
            wallet_address: wallet_address, 
            name, 
            phone, 
            email,
            company, 
            sector, 
            role, 
            updated_at: new Date(),
        }, {
            onConflict: 'wallet_address'
        })
        .select().single();

    if (error) {
        console.error(" -> Supabase upsert error:", error);
        throw new Error(`Failed to upsert user in Supabase: ${error.message}`);
    }
    console.log(" -> User profile upserted successfully in Supabase.");
    return data;
};

export const saveRegistrationData = async ({ eventAddress, wallet_address, name, phone, email, company, sector, role, mint_address }) => {
    
    console.log(` -> Garantindo perfil para a carteira: ${wallet_address}`);
    const { data: profileData, error: profileError } = await supabase
        .from('profiles')
        .upsert({ 
            wallet_address: wallet_address, 
            name: name,
            email: email,
            updated_at: new Date()
        }, {
            onConflict: 'wallet_address'
        })
        .select('id')
        .single();

    if (profileError) {
        console.error("Erro ao fazer upsert no perfil:", profileError);
        if (profileError.message.includes('profiles_email_key')) {
            throw new Error('Este email já está em uso por outra conta.');
        }
        throw new Error("Falha ao salvar dados do perfil.");
    }

    if (!profileData) {
        throw new Error("Não foi possível obter o ID do perfil após o upsert.");
    }

    const profile_id = profileData.id;
    console.log(` -> Perfil garantido. ID: ${profile_id}`);

    const registrationDetails = { name, phone, email, company, sector, role };
    console.log(` -> Criando novo registro para o evento ${eventAddress} com o mint ${mint_address}`);

    const { data: newRegistration, error: registrationError } = await supabase
        .from('registrations')
        .insert({
            profile_id: profile_id,
            event_address: eventAddress,
            registration_details: registrationDetails,
            mint_address: mint_address 
        })
        .select('id')
        .single();

    if (registrationError || !newRegistration) {
        console.error("Erro ao inserir registro:", registrationError);
        throw new Error("Falha ao criar o registro do ingresso.");
    }

    console.log(`[💾] Dados de registro salvos com sucesso! ID do Registro: ${newRegistration.id}`);
    
    return newRegistration.id;
};

export default supabase;
