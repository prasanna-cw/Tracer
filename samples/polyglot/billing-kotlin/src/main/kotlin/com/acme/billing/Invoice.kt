package com.acme.billing

data class Invoice(val orderId: String, val cents: Long) {
    fun flagForReview() = println("review $orderId")
}
