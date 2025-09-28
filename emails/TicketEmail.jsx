import * as React from 'react';
import { Html, Head, Body, Container, Heading, Text, Img, Section, Hr, Button } from '@react-email/components';

// Este é um componente React que define a aparência do seu e-mail.
export function TicketEmail({ userName, eventName, eventDate, eventLocation }) {
  const formattedDate = new Date(eventDate).toLocaleString('pt-BR', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: 'America/Sao_Paulo',
  });

  return (
    <Html>
      <Head />
      <Body style={main}>
        <Container style={container}>
          <Img
            src="https://sua-cdn.com/logo.png" // ✨ SUBSTITUA PELO LINK DO SEU LOGO
            width="120"
            alt="Ticketfy Logo"
            style={logo}
          />
          <Heading style={h1}>Seu ingresso chegou!</Heading>
          <Text style={text}>
            Olá, <strong>{userName}</strong>!
          </Text>
          <Text style={text}>
            Obrigado por garantir sua presença. Seu ingresso para o evento <strong>{eventName}</strong> está anexado a este e-mail.
          </Text>
          
          <Section style={ticketDetails}>
            <Text style={detailLabel}>Evento:</Text>
            <Text style={detailValue}>{eventName}</Text>
            <Hr style={hr} />
            <Text style={detailLabel}>Data:</Text>
            <Text style={detailValue}>{formattedDate}</Text>
            <Hr style={hr} />
            <Text style={detailLabel}>Local:</Text>
            <Text style={detailValue}>{eventLocation}</Text>
          </Section>

          <Text style={text}>
            Nos vemos lá!
          </Text>
          <Text style={footer}>
            Equipe Ticketfy
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

// Estilos para o e-mail (CSS-in-JS)
const main = {
  backgroundColor: '#f6f9fc',
  fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Ubuntu,sans-serif',
};

const container = {
  backgroundColor: '#ffffff',
  margin: '0 auto',
  padding: '20px 0 48px',
  marginBottom: '64px',
  borderRadius: '8px',
};

const logo = {
  margin: '0 auto',
};

const h1 = {
  color: '#1d2333',
  fontSize: '28px',
  fontWeight: 'bold',
  textAlign: 'center',
  margin: '30px 0',
};

const text = {
  color: '#3c414a',
  fontSize: '16px',
  lineHeight: '26px',
  margin: '16px 30px',
};

const ticketDetails = {
    border: '1px solid #e2e8f0',
    borderRadius: '8px',
    padding: '20px',
    margin: '20px 30px',
};

const detailLabel = {
    color: '#64748b',
    fontSize: '12px',
    textTransform: 'uppercase',
};

const detailValue = {
    color: '#1d2333',
    fontSize: '16px',
    fontWeight: 'bold',
    margin: '4px 0 12px 0',
};

const hr = {
    borderColor: '#e2e8f0',
    margin: '12px 0',
};

const footer = {
  color: '#8898aa',
  fontSize: '12px',
  lineHeight: '16px',
  margin: '16px 30px',
};
