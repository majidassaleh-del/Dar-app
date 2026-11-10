import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthCryptoService } from './auth-crypto.service';
import { OtpDeliveryService } from './otp-delivery.service';
import { OnboardingGuard } from './onboarding.guard';
import { IdpAdminService } from './idp-admin.service';

@Global()
@Module({ controllers: [AuthController], providers: [AuthCryptoService, OtpDeliveryService, OnboardingGuard, IdpAdminService], exports: [AuthCryptoService, OtpDeliveryService, OnboardingGuard, IdpAdminService] })
export class AuthModule {}
