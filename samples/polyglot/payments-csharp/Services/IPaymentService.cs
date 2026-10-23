namespace Acme.Payments.Services;

public interface IPaymentService
{
    string Charge(string orderId, decimal amount);
}
