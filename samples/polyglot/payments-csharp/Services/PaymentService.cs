using Acme.Payments.Models;

namespace Acme.Payments.Services;

public class PaymentService : IPaymentService
{
    public string Charge(string orderId, decimal amount)
    {
        var payment = new Payment(orderId, amount);
        try
        {
            return payment.Capture();
        }
        catch (InvalidOperationException)
        {
            return "declined";
        }
    }
}
