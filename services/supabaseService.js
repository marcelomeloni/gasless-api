// services/supabaseService.js
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from '../config/index.js';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

console.log(`[+] Supabase client initialized.`);
export const saveCompleteEventToSupabase = async (eventData) => {
    const { 
        eventAddress, 
        eventId, 
        metadata, // Já é o objeto COMPLETO
        imageUrl, 
        createdBy,
        controller,
        salesStartDate,
        salesEndDate,
        maxTicketsPerWallet,
        royaltyBps,
        tiers
    } = eventData;
    
    console.log(`[💾] Salvando evento COMPLETO no Supabase: ${eventAddress}`);

    const { data, error } = await supabase
        .from('events')
        .insert({
            event_address: eventAddress,
            event_id: eventId,
            metadata: metadata, // JSON completo com nome, descrição, organizer, etc
            image_url: imageUrl,
            created_by: createdBy,
            controller: controller,
            sales_start_date: salesStartDate,
            sales_end_date: salesEndDate,
            max_tickets_per_wallet: maxTicketsPerWallet,
            royalty_bps: royaltyBps,
            tiers: tiers
        })
        .select()
        .single();

    if (error) {
        console.error(" ❌ Erro ao salvar evento no Supabase:", error);
        throw new Error(`Falha ao salvar evento no Supabase: ${error.message}`);
    }
    
    console.log(" ✅ Evento salvo COMPLETAMENTE no Supabase (sem dependência do Pinata)");
    return data;
};

// Busca eventos ativos APENAS do Supabase (SUPER RÁPIDO)
export const getActiveEventsFromSupabase = async () => {
    console.log('[⚡] Buscando eventos ativos APENAS do Supabase...');
    const startTime = Date.now();
    
    const nowInSeconds = Math.floor(Date.now() / 1000);
    
    const { data, error } = await supabase
        .from('events')
        .select('*')
        .gte('sales_end_date', nowInSeconds) // Eventos que ainda não terminaram
        .order('sales_start_date', { ascending: true });

    if (error) {
        console.error(' ❌ Erro ao buscar eventos do Supabase:', error);
        throw error;
    }

    const duration = Date.now() - startTime;
    console.log(`[⚡] ${data?.length || 0} eventos carregados do Supabase em ${duration}ms`);
    
    return data || [];
};

// Busca detalhes de UM evento APENAS do Supabase
export const getEventFromSupabase = async (eventAddress) => {
    console.log(`[⚡] Buscando evento do Supabase: ${eventAddress}`);
    
    const { data, error } = await supabase
        .from('events')
        .select('*')
        .eq('event_address', eventAddress)
        .single();

    if (error) {
        console.error(' ❌ Erro ao buscar evento do Supabase:', error);
        throw error;
    }

    return data;
};

// Busca eventos por criador (para página de gestão)
export const getEventsByCreator = async (creatorAddress) => {
    console.log(`[⚡] Buscando eventos do criador: ${creatorAddress}`);
    
    const { data, error } = await supabase
        .from('events')
        .select('*')
        .eq('created_by', creatorAddress)
        .order('created_at', { ascending: false });

    if (error) {
        console.error(' ❌ Erro ao buscar eventos do criador:', error);
        throw error;
    }

    return data || [];
};
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
export { supabase };
export default supabase;
