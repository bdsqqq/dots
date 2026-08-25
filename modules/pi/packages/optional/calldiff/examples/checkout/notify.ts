export function notifyCustomer(userId: string, template: string) {
  const body = renderTemplate(template);
  sendEmail(userId, body);
}
function renderTemplate(template: string): string {
  return template;
}
function sendEmail(_userId: string, _body: string) {}
