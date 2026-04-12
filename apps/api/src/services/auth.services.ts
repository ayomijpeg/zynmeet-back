import jwt from 'jsonwebtoken';

export const generateAuthToken = (userId: string) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET!, {
    expiresIn: '7d', // Professional persistence
  });
};
