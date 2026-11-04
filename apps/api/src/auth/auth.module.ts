import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthCryptoService } from './auth-crypto.service';
import { OtpDeliveryService } from './otp-delivery.service';
import { OnboardingGuard } from './onboarding.guard';

@Global()
@Module({ controllers: [AuthController], providers: [AuthCryptoService, OtpDeliveryService, OnboardingGuard], exports: [AuthCryptoService, OtpDeliveryService, OnboardingGuard] })
export class AuthModule {}
